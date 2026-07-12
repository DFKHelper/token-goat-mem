import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db.js";
import { buildHintFormat, TGMEM_FOOTER_LINE, TGMEM_HEADER } from "../../src/integration-seam.js";
import type { Fact } from "../../src/types.js";
import type { HintFormatResult } from "../../src/integration-seam.js";

/** TGMEM/2's fact-lines, with the trailing footer-line (if any) stripped -- for assertions about the fact caps/ordering that predate the footer line. */
function factLines(result: HintFormatResult): readonly string[] {
  return result.lines.filter((line) => line !== TGMEM_FOOTER_LINE);
}

interface FactSeed {
  readonly id: string;
  readonly text: string;
  readonly kind: Fact["kind"];
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly scope: Fact["scope"];
  readonly scopeRoot?: string | null;
  readonly source_type: Fact["source_type"];
  readonly captured_at: string;
  readonly anchor?: string | null;
  readonly status: Fact["status"];
  readonly confidence?: number;
}

function seedFacts(dbPath: string, seeds: readonly FactSeed[]): void {
  const db = openDb(dbPath);
  const insert = db.prepare(
    `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence)
     VALUES (@id, @text, @kind, @subject, @value, @scope, @scopeRoot, @source_type, @source_ref, @captured_at, @anchor, @status, @confidence)`
  );
  for (const seed of seeds) {
    insert.run({
      id: seed.id,
      text: seed.text,
      kind: seed.kind,
      subject: seed.subject ?? null,
      value: seed.value ?? null,
      scope: seed.scope,
      scopeRoot: seed.scopeRoot ?? null,
      source_type: seed.source_type,
      source_ref: null,
      captured_at: seed.captured_at,
      anchor: seed.anchor ?? null,
      status: seed.status,
      confidence: seed.confidence ?? 1,
    });
  }
  db.close();
}

describe("buildHintFormat", () => {
  let workDir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mem-seam-test-"));
    root = join(workDir, "project");
    mkdirSync(root, { recursive: true });
    dbPath = join(workDir, "mem.db");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns just the header with no lines when the store is empty", async () => {
    const result = await buildHintFormat({ root, dbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("fails open (never throws, returns an empty result) when the db cannot be opened", async () => {
    const brokenDbPath = join(workDir, "not-a-sqlite-file");
    mkdirSync(brokenDbPath); // a directory, not a valid sqlite file -- new Database() on this must throw
    const result = await buildHintFormat({ root, dbPath: brokenDbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
  });

  it("fails open when root does not resolve to anything usable", async () => {
    // No facts seeded at all; this mainly asserts the function still resolves cleanly end to end.
    const result = await buildHintFormat({ root: join(root, "deeply", "nested", "missing"), dbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
  });

  it("surfaces a global preference with a verify caveat even when unverified (no anchor)", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-1",
        text: "uses pnpm not npm",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath, protocolVersion: 1 });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("pref  fresh=unverified  id=pref-1");
    expect(result.lines[0]).toContain("verify");
  });

  it("surfaces a decision without a forced caveat once its anchor is affirmed", async () => {
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");
    seedFacts(dbPath, [
      {
        id: "dec-1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });
    expect(factLines(result)).toHaveLength(1);
    expect(result.lines[0]).toContain("dec  fresh=affirmed  id=dec-1");
    expect(result.lines[0]).not.toContain("(verify)");
    expect(result.lines[result.lines.length - 1]).toBe(TGMEM_FOOTER_LINE);
  });

  it("excludes a fact whose anchor is contradicted", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-2",
        text: "uses the old auth service",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists definitely-missing-file.txt",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("excludes pending facts", async () => {
    seedFacts(dbPath, [
      {
        id: "pend-1",
        text: "candidate fact",
        kind: "fact",
        scope: "global",
        source_type: "derived",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
      },
    ]);
    const result = await buildHintFormat({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("excludes contested facts (ambiguous same-subject contradiction, tied precedence)", async () => {
    seedFacts(dbPath, [
      {
        id: "tie-1",
        text: "uses npm",
        kind: "preference",
        subject: "package-manager",
        value: "npm",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "tie-2",
        text: "uses pnpm",
        kind: "preference",
        subject: "package-manager",
        value: "pnpm",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);
    const result = await buildHintFormat({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("includes a project-scoped fact only when --root matches its bound project root", async () => {
    const otherRoot = join(workDir, "other-project");
    mkdirSync(otherRoot, { recursive: true });
    seedFacts(dbPath, [
      {
        id: "proj-1",
        text: "staging db is prod-staging-db-1",
        kind: "fact",
        scope: "project",
        scopeRoot: otherRoot,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const resultForRoot = await buildHintFormat({ root, dbPath });
    expect(resultForRoot.lines).toEqual([]);

    const resultForOtherRoot = await buildHintFormat({ root: otherRoot, dbPath });
    expect(factLines(resultForOtherRoot)).toHaveLength(1);
  });

  it("includes a path-scoped fact only when a matching --context-files entry is passed", async () => {
    const filePath = join(root, "src", "auth.ts");
    seedFacts(dbPath, [
      {
        id: "path-1",
        text: "auth.ts owns migrations",
        kind: "fact",
        scope: "path",
        scopeRoot: filePath,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const withoutContext = await buildHintFormat({ root, dbPath });
    expect(withoutContext.lines).toEqual([]);

    const withContext = await buildHintFormat({ root, dbPath, contextFiles: ["src/auth.ts"] });
    expect(factLines(withContext)).toHaveLength(1);
  });

  it("caps aggressively-recalled kinds (preference/correction) at 8", async () => {
    const seeds: FactSeed[] = [];
    for (let i = 0; i < 12; i += 1) {
      seeds.push({
        id: `pref-cap-${i}`,
        text: `preference number ${i}`,
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        status: "active",
      });
    }
    seedFacts(dbPath, seeds);

    const result = await buildHintFormat({ root, dbPath });
    expect(factLines(result)).toHaveLength(8);
  });

  it("caps precision-recalled kinds (decision/fact) at 4", async () => {
    const seeds: FactSeed[] = [];
    for (let i = 0; i < 6; i += 1) {
      seeds.push({
        id: `fact-cap-${i}`,
        text: `fact number ${i}`,
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        status: "active",
      });
    }
    seedFacts(dbPath, seeds);

    const result = await buildHintFormat({ root, dbPath });
    expect(factLines(result)).toHaveLength(4);
  });

  it("emits a well-formed TGMEM/1 line whose display field is valid JSON", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-json",
        text: 'has "quotes" and — a dash',
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath, protocolVersion: 1 });
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line).toBeDefined();
    const match = /^pref {2}fresh=\w+ {2}id=pref-json {2}display=(.+)$/.exec(line ?? "");
    expect(match).not.toBeNull();
    const displayJson = match?.[1] ?? "";
    expect(() => JSON.parse(displayJson)).not.toThrow();
  });

  it("emits every line conforming to the normative TGMEM/1 grammar (integration-seam.ts doc comment)", async () => {
    seedFacts(dbPath, [
      {
        id: "g-pref",
        text: 'pref with "quotes" and — a dash',
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-corr",
        text: "never run npm install here",
        kind: "correction",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-dec",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-03T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-fact",
        text: "staging DB host is db.internal",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-04T00:00:00.000Z",
        status: "pinned",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath, protocolVersion: 1 });
    expect(result.header).toBe("TGMEM/1");
    expect(result.lines).toHaveLength(4);

    // The exact consumer-side regex the grammar doc comment publishes. Every produced line must
    // match it, and the final capture must JSON.parse to a non-empty display string -- if this
    // test breaks, either fix the producer or bump TGMEM_PROTOCOL_VERSION and the grammar together.
    const grammar = /^(pref|dec|fact|corr) {2}fresh=(affirmed|unverified|contradicted) {2}id=(\S+) {2}display=(".*")$/u;
    for (const line of result.lines) {
      const match = grammar.exec(line);
      expect(match, `line does not match TGMEM/1 grammar: ${line}`).not.toBeNull();
      expect(line).not.toContain("\n");
      const display: unknown = JSON.parse(match?.[4] ?? "null");
      expect(typeof display).toBe("string");
      expect((display as string).length).toBeGreaterThan(0);
    }
  });

  it("TGMEM/2 (default): strips the per-line CTA and appends one shared footer line", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-cta",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");

    const result = await buildHintFormat({ root, dbPath });
    expect(result.header).toBe("TGMEM/2");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toBe('dec  fresh=affirmed  id=dec-cta  display="decision: chose Postgres over Mongo"');
    expect(result.lines[1]).toBe(TGMEM_FOOTER_LINE);
  });

  it("TGMEM/2: omits the footer line when there are no fact-lines", async () => {
    const result = await buildHintFormat({ root, dbPath });
    expect(result.header).toBe("TGMEM/2");
    expect(result.lines).toEqual([]);
  });

  it("TGMEM/1 (explicit protocolVersion: 1): no footer line, per-line CTA preserved", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-v1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");

    const result = await buildHintFormat({ root, dbPath, protocolVersion: 1 });
    expect(result.header).toBe("TGMEM/1");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe('dec  fresh=affirmed  id=dec-v1  display="decision: chose Postgres over Mongo — mem show dec-v1"');
  });

  it("--stable sorts fact-lines by id ascending, independent of relevance/recency order", async () => {
    seedFacts(dbPath, [
      {
        id: "z-newest",
        text: "captured most recently",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-03T00:00:00.000Z",
        status: "active",
      },
      {
        id: "a-oldest",
        text: "captured earliest",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "m-middle",
        text: "captured in between",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
    ]);

    const defaultOrder = await buildHintFormat({ root, dbPath });
    expect(factLines(defaultOrder).map((line) => line.split("  ")[2])).toEqual(["id=z-newest", "id=m-middle", "id=a-oldest"]);

    const stableOrder = await buildHintFormat({ root, dbPath, stable: true });
    expect(factLines(stableOrder).map((line) => line.split("  ")[2])).toEqual(["id=a-oldest", "id=m-middle", "id=z-newest"]);
  });
});
