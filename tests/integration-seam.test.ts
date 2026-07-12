/**
 * Tests for the token-goat integration seam (src/integration-seam.ts, design plan Section 4).
 *
 * Focus, per the design plan:
 *   - happy path: a well-formed TGMEM/<n> hint-format payload for an in-scope, affirmed fact.
 *   - fail-open on internal error: buildHintFormat() must never throw -- any internal failure
 *     (unreadable db, retrieval exception) resolves to an empty, well-formed result.
 *   - contested facts excluded from hint-format (Section 4: "Contested / low-trust / pending facts
 *     are excluded from --hint-format entirely").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { buildHintFormat, TGMEM_HEADER } from "../src/integration-seam.js";
import type { Fact } from "../src/types.js";

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

describe("buildHintFormat (integration seam)", () => {
  let workDir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mem-seam-integration-"));
    root = join(workDir, "project");
    mkdirSync(root, { recursive: true });
    dbPath = join(workDir, "mem.db");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("happy path: emits a well-formed TGMEM/<n> payload for an in-scope active preference", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-happy",
        text: "uses pnpm not npm",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });

    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.header).toBe("TGMEM/1");
    expect(result.truncated).toBe(false);
    expect(result.lines).toHaveLength(1);

    const line = result.lines[0];
    expect(line).toBeDefined();
    // Wire format: `<tag>  fresh=<verdict>  id=<id>  display=<json-string>`.
    const match = /^pref {2}fresh=(\w+) {2}id=pref-happy {2}display=(.+)$/.exec(line ?? "");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("unverified"); // no anchor set -> can't be positively affirmed
    const display = JSON.parse(match?.[2] ?? "");
    expect(typeof display).toBe("string");
    expect(display).toContain("uses pnpm not npm");
  });

  it("fails open (never throws, returns an empty well-formed result) when the db cannot be opened", async () => {
    const brokenDbPath = join(workDir, "not-a-sqlite-file");
    mkdirSync(brokenDbPath); // a directory, not a valid sqlite file -- `new Database()` on this must throw

    await expect(buildHintFormat({ root, dbPath: brokenDbPath })).resolves.not.toThrow();
    const result = await buildHintFormat({ root, dbPath: brokenDbPath });

    expect(result).toEqual({ header: TGMEM_HEADER, lines: [], truncated: false });
  });

  it("fails open when the resolved db path's parent cannot be created (permission/invalid-path style failure)", async () => {
    // A null byte is invalid in a path on every platform Node targets, so this reliably throws
    // inside openDb()/mkdirSync() rather than depending on OS-specific permission setup.
    const invalidDbPath = join(workDir, "bad\0path", "mem.db");

    const result = await buildHintFormat({ root, dbPath: invalidDbPath });

    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("excludes contested facts from hint-format even though a non-hint-format retrieval would surface them as a hint", async () => {
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
        captured_at: "2026-01-01T00:00:00.000Z", // identical timestamp + provenance -> tied precedence -> contested
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });

    // Neither side of the tied contradiction is surfaced -- the seam never hands the caller an
    // unresolved either/or to gamble on (design plan P4 / Section 4).
    expect(result.lines).toEqual([]);
    expect(result.header).toBe(TGMEM_HEADER);
  });

  it("still excludes a contested fact even when another, unrelated fact is in scope (contested filtering is per-subject, not all-or-nothing)", async () => {
    seedFacts(dbPath, [
      {
        id: "tie-a",
        text: "uses jest",
        kind: "preference",
        subject: "test-framework",
        value: "jest",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-02-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "tie-b",
        text: "uses vitest",
        kind: "preference",
        subject: "test-framework",
        value: "vitest",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-02-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "unrelated-1",
        text: "no default exports",
        kind: "preference",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-02-02T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("id=unrelated-1");
    expect(result.lines.some((line) => line.includes("tie-a") || line.includes("tie-b"))).toBe(false);
  });
});
