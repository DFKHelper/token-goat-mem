import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { openStorage } from "../src/storage.js";
import { importFromJson, JsonImportError, planImportFromJson } from "../src/exportImport.js";

// ─────────────────────────────────────────────────────────────────────────── planImportFromJson (dry-run, DB-free) ───────────────────────────────────────────────────────────────────────────

function envelope(facts: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), facts });
}

const VALID_FACT: Record<string, unknown> = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "uses pnpm not npm",
  kind: "preference",
  subject: "package-manager",
  value: "pnpm",
  scope: "global",
  scopeRoot: null,
  source_type: "user",
  source_ref: null,
  captured_at: "2026-01-01T00:00:00.000Z",
  anchor: null,
  status: "active",
  confidence: 1,
  embedding: null,
};

describe("planImportFromJson", () => {
  it("produces dry_run outcomes for every valid candidate without opening a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-exportimport-plan-"));
    const path = join(dir, "export.json");
    writeFileSync(path, envelope([VALID_FACT]), "utf8");
    try {
      const result = planImportFromJson({ path });
      expect(result.candidates).toHaveLength(1);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]?.status).toBe("dry_run");
      expect(result.outcomes[0]?.candidate.text).toBe("uses pnpm not npm");
      expect(result.filePath).toBe(resolve(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a structurally invalid fact as skipped_error without aborting the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-exportimport-plan-"));
    const path = join(dir, "export.json");
    const badFact = { ...VALID_FACT, id: undefined };
    writeFileSync(path, envelope([VALID_FACT, badFact]), "utf8");
    try {
      const result = planImportFromJson({ path });
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]?.status).toBe("dry_run");
      expect(result.outcomes[1]?.status).toBe("skipped_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws JsonImportError for a schemaVersion mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-exportimport-plan-"));
    const path = join(dir, "export.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), facts: [] }), "utf8");
    try {
      expect(() => planImportFromJson({ path })).toThrow(JsonImportError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws JsonImportError for malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-exportimport-plan-"));
    const path = join(dir, "export.json");
    writeFileSync(path, "{ not valid json", "utf8");
    try {
      expect(() => planImportFromJson({ path })).toThrow(JsonImportError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── importFromJson (DB-backed) ───────────────────────────────────────────────────────────────────────────

let root: string;
let db: Database.Database;
let jsonPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-exportimport-test-"));
  db = openStorage(join(root, "mem.db"));
  jsonPath = join(root, "export.json");
  writeFileSync(jsonPath, envelope([VALID_FACT]), "utf8");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("importFromJson", () => {
  it("imports a fact preserving its original id, status, confidence, and captured_at", () => {
    const result = importFromJson(db, { path: jsonPath, root });
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe("imported");
    if (outcome?.status !== "imported") {
      throw new Error("expected imported outcome");
    }
    expect(outcome.fact.id).toBe(VALID_FACT["id"]);
    expect(outcome.fact.status).toBe("active");
    expect(outcome.fact.confidence).toBe(1);
    expect(outcome.fact.captured_at).toBe(VALID_FACT["captured_at"]);
    expect(outcome.fact.source_type).toBe("user");
  });

  it("--dry-run reports candidates but writes nothing", () => {
    const before = db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    const result = importFromJson(db, { path: jsonPath, root, dryRun: true });
    expect(result.outcomes.every((o) => o.status === "dry_run")).toBe(true);
    const after = db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("re-importing the same file does not create duplicate facts", () => {
    importFromJson(db, { path: jsonPath, root });
    const countAfterFirst = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;
    expect(countAfterFirst).toBe(1);

    const second = importFromJson(db, { path: jsonPath, root });
    const countAfterSecond = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.outcomes.every((o) => o.status === "skipped_duplicate")).toBe(true);
  });

  it("round-trips a Float32Array embedding through the JSON number[] <-> Float32Array conversion", () => {
    const withEmbedding = { ...VALID_FACT, id: "22222222-2222-2222-2222-222222222222", embedding: [0.5, -0.25, 1] };
    writeFileSync(jsonPath, envelope([withEmbedding]), "utf8");

    const result = importFromJson(db, { path: jsonPath, root });
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe("imported");
    if (outcome?.status !== "imported") {
      throw new Error("expected imported outcome");
    }
    expect(outcome.fact.embedding).not.toBeNull();
    expect(Array.from(outcome.fact.embedding ?? [])).toEqual([
      Math.fround(0.5),
      Math.fround(-0.25),
      Math.fround(1),
    ]);
  });

  it("skips a fact carrying a high-entropy secret value, without aborting the rest of the import", () => {
    const secretFact = {
      ...VALID_FACT,
      id: "33333333-3333-3333-3333-333333333333",
      subject: null,
      value: "AKIAABCDEFGHIJKLMNOP",
    };
    writeFileSync(jsonPath, envelope([VALID_FACT, secretFact]), "utf8");

    const result = importFromJson(db, { path: jsonPath, root });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]?.status).toBe("imported");
    expect(result.outcomes[1]?.status).toBe("skipped_error");

    const count = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("a structurally invalid fact is skipped_error and does not abort the rest of the import", () => {
    const badFact = { ...VALID_FACT, id: "44444444-4444-4444-4444-444444444444", kind: "not-a-real-kind" };
    writeFileSync(jsonPath, envelope([VALID_FACT, badFact]), "utf8");

    const result = importFromJson(db, { path: jsonPath, root });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]?.status).toBe("imported");
    expect(result.outcomes[1]?.status).toBe("skipped_error");

    const count = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
