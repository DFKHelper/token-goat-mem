/**
 * End-to-end tests for the facet layer's CLI and storage surface: `mem facets`, the write path that
 * populates `fact_terms`, and `mem recall --entity`.
 *
 * Driven through the real `run()` against a real database. The one thing these tests must actually
 * prove is that the layer earns its existence -- that `--entity src/retrieval.ts` distinguishes a
 * fact BM25 cannot -- so that case is pinned twice: once as a positive hit, and once as the
 * demonstration that the lexical query alone does not tell the two facts apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { deleteFact, listTermsForFact, openStorage } from "../src/storage.js";

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-facets-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-facets-root-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Mirrors tests/cli.test.ts's extractor: `mem remember` prints "remembered <noun phrase> <id>". */
function extractRememberedId(result: CliResult): string {
  const match = /remembered (?:\S+ )?fact (\S+)/u.exec(result.stdout);
  if (match?.[1] === undefined) {
    throw new Error(`could not extract fact id from stdout: ${JSON.stringify(result.stdout)}`);
  }
  return match[1];
}

async function remember(text: string, extra: readonly string[] = []): Promise<string> {
  const result = await runCli(["remember", text, "--kind", "fact", "--scope", "project", "--root", root, ...extra]);
  expect(result.exitCode).toBe(0);
  return extractRememberedId(result);
}

/** Raw `fact_terms` rows in storage order, for the idempotence and cascade assertions. */
function readTermRows(): Array<{ fact_id: string; term: string; term_key: string; kind: string }> {
  const db = openStorage(resolveDbPath());
  try {
    return db
      .prepare<[], { fact_id: string; term: string; term_key: string; kind: string }>(
        "SELECT fact_id, term, term_key, kind FROM fact_terms ORDER BY fact_id, kind, term_key"
      )
      .all();
  } finally {
    db.close();
  }
}

describe("mem recall --entity: the query BM25 cannot answer", () => {
  it("finds a fact by the exact file path in its text, where the lexical query alone does not distinguish it", async () => {
    const ranking = await remember("the ranking pipeline lives in src/retrieval.ts");
    // The decoy shares every BM25 term the query produces -- `tokenize` reduces "src/retrieval.ts"
    // to src / retriev / ts, all three of which this sentence contains -- and mentions no such file.
    const decoy = await remember("the ts compiler reads src files during retrieval of build output");

    // BM25 alone: both facts come back, and the lexical query has no way to prefer the real one.
    const lexical = await runCli(["recall", "src/retrieval.ts", "--root", root]);
    expect(lexical.exitCode).toBe(0);
    expect(lexical.stdout).toContain(ranking.slice(0, 8));
    expect(lexical.stdout).toContain(decoy.slice(0, 8));

    // The facet layer: only the fact whose text actually names the file.
    const faceted = await runCli(["recall", "--entity", "src/retrieval.ts", "--root", root]);
    expect(faceted.exitCode).toBe(0);
    expect(faceted.stdout).toContain(ranking.slice(0, 8));
    expect(faceted.stdout).not.toContain(decoy.slice(0, 8));
  });

  it("matches case-insensitively while storing the spelling the fact used", async () => {
    const id = await remember("we run PostgreSQL in production");

    const recalled = await runCli(["recall", "--entity", "postgresql", "--root", root]);
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toContain(id.slice(0, 8));

    const shown = await runCli(["facets", "--fact", id]);
    expect(shown.stdout).toContain("entities: PostgreSQL");
  });

  it("ANDs repeated --entity flags rather than ORing them", async () => {
    const both = await remember("src/cli.ts passes --hint-format straight through");
    const onlyPath = await remember("src/cli.ts also parses --limit");
    const onlyFlag = await remember("the seam contract is --hint-format only");

    const anded = await runCli(["recall", "--entity", "src/cli.ts", "--entity", "--hint-format", "--root", root]);
    expect(anded.exitCode).toBe(0);
    expect(anded.stdout).toContain(both.slice(0, 8));
    expect(anded.stdout).not.toContain(onlyPath.slice(0, 8));
    expect(anded.stdout).not.toContain(onlyFlag.slice(0, 8));
  });

  it("reports an entity nothing carries as no match, rather than falling back to the whole store", async () => {
    await remember("we run PostgreSQL in production");
    const result = await runCli(["recall", "--entity", "src/nowhere.ts", "--root", root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matching facts");
  });

  it("refuses --entity on the --hint-format seam, which has its own flag contract", async () => {
    const result = await runCli(["recall", "--hint-format", "--root", root, "--entity", "src/cli.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--entity");
  });

  it("still withholds a contested fact reached via --entity, because the filter runs inside retrieve()", async () => {
    // The rival deliberately does NOT mention the file. If `--entity` narrowed the candidate pool
    // instead of filtering inside `retrieve`, the rival would be absent when contradictions are
    // resolved, `resolveContradictions`'s reinstatement pass would read that absence as "nothing
    // contests this fact", and a genuinely contested fact would surface as clean ground truth.
    const withEntity = await runCli([
      "remember",
      "the store lives at src/storage.ts",
      "--kind",
      "preference",
      "--subject",
      "store-location",
      "--value",
      "storage",
      "--scope",
      "project",
      "--root",
      root,
    ]);
    const idA = extractRememberedId(withEntity);
    const rival = await runCli([
      "remember",
      "the store lives in the database module",
      "--kind",
      "preference",
      "--subject",
      "store-location",
      "--value",
      "database",
      "--scope",
      "project",
      "--root",
      root,
    ]);
    const idB = extractRememberedId(rival);

    // Tie captured_at so precedence is genuinely ambiguous and the pair is contested rather than
    // superseded -- the same determinism fix tests/cli.test.ts applies to its contested pair.
    const db = openDb(resolveDbPath());
    db.prepare("UPDATE facts SET captured_at = ? WHERE id IN (?, ?)").run("2026-01-01T00:00:00.000Z", idA, idB);
    db.close();

    const faceted = await runCli(["recall", "--entity", "src/storage.ts", "--root", root]);
    expect(faceted.exitCode).toBe(0);
    expect(faceted.stdout).toContain(idA.slice(0, 8));
    expect(faceted.stdout).toContain("(contested, excluded)");
    // The rival itself is filtered out of the results -- it carries no such entity -- which is
    // exactly why its influence on the verdict is the thing under test.
    expect(faceted.stdout).not.toContain(idB.slice(0, 8));
  });
});

describe("fact_terms write path", () => {
  it("populates terms on capture, without a backfill step", async () => {
    const id = await remember("bump the pin to v2.1.0 in package.json");
    const terms = readTermRows().filter((row) => row.fact_id === id);
    const entities = terms.filter((row) => row.kind === "entity").map((row) => row.term);
    expect(entities).toEqual(expect.arrayContaining(["v2.1.0", "package.json"]));
    expect(terms.some((row) => row.kind === "topic")).toBe(true);
  });

  it("re-extracts when `mem edit` rewrites a fact's text, so terms never describe the old text", async () => {
    const id = await remember("the ranking lives in src/retrieval.ts");
    const edited = await runCli(["edit", id, "--text", "the ranking moved to src/ranking.ts"]);
    expect(edited.exitCode).toBe(0);

    const stale = await runCli(["recall", "--entity", "src/retrieval.ts", "--root", root]);
    expect(stale.stdout).toContain("no matching facts");
    const fresh = await runCli(["recall", "--entity", "src/ranking.ts", "--root", root]);
    expect(fresh.stdout).toContain(id.slice(0, 8));
  });

  it("leaves no orphaned term rows when a fact is hard-deleted (ON DELETE CASCADE)", async () => {
    const id = await remember("the ranking lives in src/retrieval.ts");
    expect(readTermRows().some((row) => row.fact_id === id)).toBe(true);

    const db = openStorage(resolveDbPath());
    try {
      expect(deleteFact(db, id)).toBe(true);
    } finally {
      db.close();
    }
    expect(readTermRows().filter((row) => row.fact_id === id)).toEqual([]);
  });
});

describe("mem facets", () => {
  it("backfills facts that have no terms and reports what it did", async () => {
    const id = await remember("the ranking lives in src/retrieval.ts");
    // Simulate a store written before the facet layer existed: drop the rows the write path added.
    const db = openStorage(resolveDbPath());
    try {
      db.prepare("DELETE FROM fact_terms").run();
    } finally {
      db.close();
    }
    expect(readTermRows()).toEqual([]);

    const backfilled = await runCli(["facets"]);
    expect(backfilled.exitCode).toBe(0);
    expect(backfilled.stdout).toMatch(/extracted facets for 1 fact: \d+ entities, \d+ topics/u);
    expect(readTermRows().some((row) => row.fact_id === id && row.term === "src/retrieval.ts")).toBe(true);

    // A second run has nothing left to do, and says so instead of exiting 0 in silence.
    const again = await runCli(["facets"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("no facts need facet extraction");
  });

  it("re-extracts every fact under --all, idempotently", async () => {
    await remember("the ranking lives in src/retrieval.ts");
    await remember("we run PostgreSQL in production");

    const first = await runCli(["facets", "--all"]);
    expect(first.exitCode).toBe(0);
    const afterFirst = readTermRows();

    const second = await runCli(["facets", "--all"]);
    expect(second.exitCode).toBe(0);
    // Same rows, not merely the same count: a merge-style write would accumulate duplicates and a
    // delete-then-insert that lost its delete would double every term.
    expect(readTermRows()).toEqual(afterFirst);
    expect(second.stdout).toBe(first.stdout);
  });

  it("shows one fact's terms, resolving a short id prefix like every other id-accepting command", async () => {
    const id = await remember("bump the pin to v2.1.0 in package.json");
    const shown = await runCli(["facets", "--fact", id.slice(0, 8)]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(`fact: ${id}`);
    expect(shown.stdout).toContain("v2.1.0");
    expect(shown.stdout).toContain("package.json");
    expect(shown.stdout).toMatch(/topics: \S/u);
  });

  it("says a fact has no entities rather than printing a blank, when its text names none", async () => {
    const id = await remember("the deployment process should always be reviewed by another person");
    const shown = await runCli(["facets", "--fact", id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("entities: none");
    // Topics still exist -- the fact is ordinary prose, which is exactly what the topic facet holds.
    expect(shown.stdout).toMatch(/topics: \S/u);
  });

  it("lists distinct entities with fact counts, most frequent first", async () => {
    await remember("src/cli.ts parses the flags");
    await remember("src/cli.ts also owns exit codes");
    await remember("we run PostgreSQL in production");

    const listed = await runCli(["facets", "--list-entities"]);
    expect(listed.exitCode).toBe(0);
    const lines = listed.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\s+2\s+src\/cli\.ts$/u);
    expect(listed.stdout).toMatch(/^\s+1\s+PostgreSQL$/mu);
  });

  it("collapses two spellings of one entity onto a single listed line", async () => {
    // `--entity` matches on the normalized key, so advertising two lines here would promise a
    // distinction lookup does not make.
    await remember("the flags are parsed in src/cli.ts");
    await remember("exit codes also live in SRC/CLI.ts");

    const listed = await runCli(["facets", "--list-entities"]);
    expect(listed.stdout.match(/cli\.ts/giu)).toHaveLength(1);
    // One line, count 2, spelled `MIN(term)`'s pick -- lexicographically first under SQLite's
    // BINARY collation, which is what makes the displayed spelling deterministic rather than
    // whichever row the group happened to end on.
    expect(listed.stdout).toMatch(/^\s+2\s+SRC\/CLI\.ts$/mu);
  });

  it("refuses to combine its mutually exclusive modes rather than silently honouring one", async () => {
    const result = await runCli(["facets", "--all", "--list-entities"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("`mem doctor` names the term shortfall and the command that fixes it, so a store captured before facets existed is not silently unfilterable", async () => {
    await remember("the ranking lives in src/retrieval.ts");
    await remember("the delta filter lives in src/integration-seam.ts");

    // Exactly the shape of an upgraded store: facts predating the feature, so no terms.
    const db = openStorage(resolveDbPath());
    try {
      db.exec("DELETE FROM fact_terms");
    } finally {
      db.close();
    }

    const stale = await runCli(["doctor"]);
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toContain("term coverage: 0/2 facts");
    // The shortfall is only actionable if doctor names the remedy -- the symptom on its own
    // (`--entity` matching nothing) is indistinguishable from a store with no such entity.
    expect(stale.stdout).toContain("mem facets --backfill");

    expect((await runCli(["facets", "--backfill"])).exitCode).toBe(0);

    const healthy = await runCli(["doctor"]);
    expect(healthy.stdout).toContain("term coverage: 2/2 facts");
    // Non-firing half: a fully-covered store must not nag.
    expect(healthy.stdout).not.toContain("mem facets --backfill");
  });

  it("keeps terms for facts written by `mem import --from-json`, which bypasses the capture path", async () => {
    const id = await remember("the ranking lives in src/retrieval.ts");
    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);

    // A fresh store, so the import writes rather than deduplicating.
    const secondHome = mkdtempSync(join(tmpdir(), "mem-facets-home2-"));
    const path = join(root, "export.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, exported.stdout, "utf8");
    process.env["TOKEN_GOAT_MEM_HOME"] = secondHome;
    try {
      const imported = await runCli(["import", "--from-json", path, "--root", root]);
      expect(imported.exitCode).toBe(0);
      const db = openStorage(resolveDbPath());
      try {
        expect(listTermsForFact(db, id).map((term) => term.term)).toContain("src/retrieval.ts");
      } finally {
        db.close();
      }
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(secondHome, { recursive: true, force: true });
    }
  });
});
