/**
 * End-to-end tests for the embedding feature's CLI surface: `mem embed`, the post-capture vector
 * write, `mem doctor`'s report, and the dimension/model safety that keeps two vector spaces from
 * being compared.
 *
 * Driven through the real `run()` against a real database, and against a real (loopback) HTTP
 * endpoint (tests/support/embedding-server.ts), for the reason that file gives: mocking `fetch`
 * would test the mock's idea of the wire format.
 *
 * Every test that sets an embedding environment variable restores it afterwards. A leak here is not
 * a local failure: it would turn embeddings on for every later test file in the same worker, which
 * is exactly the byte-identical-when-unconfigured property the first block below exists to pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.js";
import { openStorage, getEmbeddingMeta, listFacts } from "../src/storage.js";
import { EMBED_API_KEY_ENV, EMBED_MODEL_ENV, EMBED_URL_ENV } from "../src/embeddings.js";
import { startStubEmbeddingServer, type StubEmbeddingServer, type StubEmbeddingServerOptions } from "./support/embedding-server.js";

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/** Mirrors tests/cli.test.ts's harness: drives the real `run()` and captures both streams. */
async function runCli(args: readonly string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    stdout += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderr += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });
  process.exitCode = undefined;
  await run(["node", "mem", ...args]);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  return { stdout, stderr, exitCode };
}

let home: string;
let root: string;
const openServers: StubEmbeddingServer[] = [];
const EMBED_ENV_KEYS = [EMBED_URL_ENV, EMBED_MODEL_ENV, EMBED_API_KEY_ENV] as const;
let priorEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-embed-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-embed-root-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
  priorEnv = Object.fromEntries(EMBED_ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  // Record/set/restore, matching tests/setup/isolate-home.ts: `delete` alone would clobber a value
  // an outer harness had set, and leaving one set would silently configure every later test.
  for (const key of EMBED_ENV_KEYS) {
    const prior = priorEnv[key];
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function configureEmbeddings(options: StubEmbeddingServerOptions & { model?: string; apiKey?: string } = {}): Promise<StubEmbeddingServer> {
  const server = await startStubEmbeddingServer(options);
  openServers.push(server);
  process.env[EMBED_URL_ENV] = server.url;
  process.env[EMBED_MODEL_ENV] = options.model ?? "stub-model";
  if (options.apiKey !== undefined) {
    process.env[EMBED_API_KEY_ENV] = options.apiKey;
  }
  return server;
}

function storedFacts(): ReturnType<typeof listFacts> {
  const db = openStorage(join(home, "mem.db"));
  try {
    return listFacts(db, {});
  } finally {
    db.close();
  }
}

function storedMeta(): ReturnType<typeof getEmbeddingMeta> {
  const db = openStorage(join(home, "mem.db"));
  try {
    return getEmbeddingMeta(db);
  } finally {
    db.close();
  }
}

async function seed(count = 3): Promise<void> {
  const texts = ["uses vitest for tests", "prefers tabs over spaces", "deploys on fridays", "the build is esbuild", "chose sqlite for storage"];
  for (const text of texts.slice(0, count)) {
    await runCli(["remember", text, "--kind", "fact", "--scope", "project", "--root", root]);
  }
}

describe("with no embedding configuration, behaviour is what it was before the feature existed", () => {
  it("stores no vector and records no model on capture", async () => {
    const result = await runCli(["remember", "prefers pnpm", "--kind", "preference", "--scope", "project", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^remembered preference fact \S+\n$/u);
    expect(storedFacts()[0]?.embedding).toBeNull();
    expect(storedMeta()).toBeUndefined();
  });

  it("recall prints no embedding note and ranks lexically", async () => {
    await seed();
    const result = await runCli(["recall", "vitest", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/embedding/u);
    expect(result.stdout.split("\n")[0]).toMatch(/uses vitest for tests/u);
  });

  it("doctor reports embeddings as off, in a line that does not read as a fault", async () => {
    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`embeddings: off \\(set ${EMBED_URL_ENV} and ${EMBED_MODEL_ENV} to enable\\)`, "u"));
    expect(result.stdout).toMatch(/embedding coverage: 0\/0 facts/u);
    expect(result.stdout).not.toMatch(/error|fail|misconfigured/iu);
  });

  it("mem embed exits non-zero and names both required variables", async () => {
    const result = await runCli(["embed"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toContain(EMBED_URL_ENV);
    expect(result.stderr).toContain(EMBED_MODEL_ENV);
  });
});

describe("post-capture embedding", () => {
  it("stores a vector and records the model on the first capture", async () => {
    await configureEmbeddings();
    const result = await runCli(["remember", "prefers pnpm", "--kind", "preference", "--scope", "project", "--root", root]);

    expect(result.exitCode).toBe(0);
    // Same single line as an unconfigured capture: the vector is an optimization and must not show
    // up in the command's contract with its caller.
    expect(result.stdout).toMatch(/^remembered preference fact \S+\n$/u);
    expect(storedFacts()[0]?.embedding).not.toBeNull();
    expect(storedMeta()).toEqual({ model: "stub-model", dimension: 4 });
  });

  it("`mem suggest` embeds too, and the fact stays pending", async () => {
    await configureEmbeddings();
    const result = await runCli(["suggest", "prefers pnpm", "--kind", "preference", "--scope", "project", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\(pending\)\n$/u);
    const [fact] = storedFacts();
    expect(fact?.status).toBe("pending");
    expect(fact?.embedding).not.toBeNull();
  });

  it("a failing backend cannot fail, slow, or change the capture", async () => {
    await configureEmbeddings({ status: 500 });
    const result = await runCli(["remember", "prefers pnpm", "--kind", "preference", "--scope", "project", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^remembered preference fact \S+\n$/u);
    // The fact is durably stored regardless; only its vector is missing.
    expect(storedFacts()[0]?.text).toBe("prefers pnpm");
    expect(storedFacts()[0]?.embedding).toBeNull();
  });

  it("refused text never reaches the endpoint, because screening runs before the network call", async () => {
    const server = await configureEmbeddings();
    const result = await runCli(["remember", "api_key = sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "--kind", "fact", "--root", root]);

    expect(result.exitCode).toBe(1);
    // The security property: capture.ts rejected the text, so nothing was stored and nothing was
    // sent. A pre-capture embedding call would have leaked the very string screening exists to stop.
    expect(server.requests).toEqual([]);
  });

  it("does not add a second model's vector to a store already embedded by another model", async () => {
    await configureEmbeddings({ model: "model-a" });
    await runCli(["remember", "first fact here", "--kind", "fact", "--root", root]);
    expect(storedMeta()).toEqual({ model: "model-a", dimension: 4 });

    process.env[EMBED_MODEL_ENV] = "model-b";
    await runCli(["remember", "second fact here", "--kind", "fact", "--root", root]);

    // Mixing vector spaces inside one store is permanent and invisible: `cosineSimilarity` compares
    // them without complaint. The second fact stays unembedded until `mem embed --all` migrates.
    expect(storedMeta()).toEqual({ model: "model-a", dimension: 4 });
    const second = storedFacts().find((fact) => fact.text === "second fact here");
    expect(second?.embedding).toBeNull();
  });
});

describe("mem embed", () => {
  it("backfills every fact missing a vector and reports counts", async () => {
    await seed(3);
    await configureEmbeddings();

    const result = await runCli(["embed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("embedded 3, skipped 0, failed 0 (model stub-model, dim 4)\n");
    expect(storedFacts().every((fact) => fact.embedding !== null)).toBe(true);
    expect(storedMeta()).toEqual({ model: "stub-model", dimension: 4 });
  });

  it("issues one request per batch, not one per fact", async () => {
    await seed(5);
    const server = await configureEmbeddings();

    await runCli(["embed"]);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body.input).toHaveLength(5);
  });

  it("says so and exits 0 when nothing needs embedding", async () => {
    await seed(2);
    await configureEmbeddings();
    await runCli(["embed"]);

    const second = await runCli(["embed"]);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("no facts need embedding\n");
  });

  it("--limit bounds the work and leaves the rest for a later run", async () => {
    await seed(4);
    await configureEmbeddings();

    const first = await runCli(["embed", "--limit", "2"]);
    expect(first.stdout).toMatch(/^embedded 2,/u);
    expect(storedFacts().filter((fact) => fact.embedding !== null)).toHaveLength(2);

    const second = await runCli(["embed"]);
    expect(second.stdout).toMatch(/^embedded 2,/u);
    expect(storedFacts().every((fact) => fact.embedding !== null)).toBe(true);
  });

  it("refuses a plain backfill under a different model, and names --all as the migration path", async () => {
    await seed(2);
    await configureEmbeddings({ model: "model-a" });
    await runCli(["embed"]);

    process.env[EMBED_MODEL_ENV] = "model-b";
    const result = await runCli(["embed"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toMatch(/mem embed --all/u);
    expect(storedMeta()).toEqual({ model: "model-a", dimension: 4 });
  });

  it("--all re-embeds everything and rewrites the recorded model", async () => {
    await seed(2);
    await configureEmbeddings({ model: "model-a" });
    await runCli(["embed"]);

    process.env[EMBED_MODEL_ENV] = "model-b";
    const result = await runCli(["embed", "--all"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^embedded 2, skipped 0, failed 0 \(model model-b, dim 4\)\n$/u);
    expect(storedMeta()).toEqual({ model: "model-b", dimension: 4 });
    expect(storedFacts().every((fact) => fact.embedding !== null)).toBe(true);
  });

  it("keeps the batches that succeeded when one batch fails, and reports the failure without discarding the run", async () => {
    // 40 facts is two batches at the 32-fact batch size; the stub fails only the second.
    const db = openStorage(join(home, "mem.db"));
    const insert = db.prepare(
      `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence)
       VALUES (?, ?, 'fact', 'global', 'user', ?, 'active', 1)`
    );
    const insertAll = db.transaction(() => {
      for (let i = 0; i < 40; i += 1) {
        insert.run(`f-${String(i).padStart(3, "0")}`, `seeded fact number ${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
      }
    });
    insertAll.immediate();
    db.close();

    let call = 0;
    await configureEmbeddings({
      dataOverride: (inputs) => {
        call += 1;
        // Second request answers with a shape the parser must reject, standing in for any
        // transport- or gateway-level failure that hits only part of a run.
        return call === 2 ? [] : inputs.map((text, index) => ({ index, embedding: [text.length, 1, 2, 3] }));
      },
    });

    const result = await runCli(["embed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^embedded 32, skipped 0, failed 8 \(model stub-model, dim 4\)\n/u);
    expect(result.stdout).toMatch(/some batches failed/u);
    expect(storedFacts().filter((fact) => fact.embedding !== null)).toHaveLength(32);
  });

  it("exits non-zero when every batch failed, rather than reporting a run of zero as a success", async () => {
    await seed(2);
    await configureEmbeddings({ status: 503 });

    const result = await runCli(["embed"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toMatch(/HTTP 503/u);
    expect(storedFacts().every((fact) => fact.embedding === null)).toBe(true);
  });
});

describe("dimension and model safety at recall", () => {
  it("refuses to rank on vectors from a different model, and says so on stdout", async () => {
    await seed(3);
    await configureEmbeddings({ model: "model-a" });
    await runCli(["embed"]);

    process.env[EMBED_MODEL_ENV] = "model-b";
    const result = await runCli(["recall", "vitest", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/note: embedding search skipped -- stored vectors were produced by model-a/u);
    // Ranking still happens; it is just lexical, which is the honest fallback.
    expect(result.stdout).toMatch(/uses vitest for tests/u);
  });

  it("ranks with the embedding list when the models agree", async () => {
    await seed(3);
    const server = await configureEmbeddings();
    await runCli(["embed"]);
    const requestsAfterBackfill = server.requests.length;

    const result = await runCli(["recall", "vitest", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/embedding search skipped/u);
    // One extra request: the query vector. Its absence would mean the backend was never wired.
    expect(server.requests.length).toBe(requestsAfterBackfill + 1);
    expect(server.requests[requestsAfterBackfill]?.body.input).toEqual(["vitest"]);
  });

  it("recall survives an endpoint that is down, falling back to lexical ranking", async () => {
    await seed(3);
    const server = await configureEmbeddings();
    await runCli(["embed"]);
    await server.close();
    openServers.length = 0;

    const result = await runCli(["recall", "vitest", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/uses vitest for tests/u);
  });

  it("doctor reports the endpoint host, the model, and key presence -- never the key itself", async () => {
    await seed(2);
    const server = await configureEmbeddings({ apiKey: "sk-doctor-secret" });
    await runCli(["embed"]);

    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/embeddings: 127\.0\.0\.1:\d+, model stub-model, api key configured/u);
    expect(result.stdout).toMatch(/embedding store: model stub-model, dim 4/u);
    expect(result.stdout).toMatch(/embedding coverage: 2\/2 facts/u);
    expect(result.stdout).not.toContain("sk-doctor-secret");
    // The full URL carries a path; only the host may reach stdout.
    expect(result.stdout).not.toContain(server.url);
  });

  it("doctor flags a model mismatch as a disabled ranking rather than leaving it invisible", async () => {
    await seed(1);
    await configureEmbeddings({ model: "model-a" });
    await runCli(["embed"]);

    process.env[EMBED_MODEL_ENV] = "model-b";
    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/embedding ranking: disabled -- stored vectors are model-a's/u);
  });

  it("doctor reports a misconfiguration without pretending embeddings are simply off", async () => {
    process.env[EMBED_URL_ENV] = "http://127.0.0.1:1/v1/embeddings";
    delete process.env[EMBED_MODEL_ENV];

    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`embeddings: misconfigured -- .*${EMBED_MODEL_ENV}`, "u"));
  });
});
