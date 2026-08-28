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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    expect(result.header).toBe("TGMEM/2");
    expect(result.truncated).toBe(false);
    expect(result.lines).toHaveLength(2); // fact-line + TGMEM/2's shared footer-line

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

  /**
   * `display` is JSON-encoded and so cannot break the consumer's line parse; `id` sits in a bare,
   * whitespace-delimited field and cannot be quoted without breaking the published TGMEM contract.
   * The emitter therefore has to refuse an unsafe id outright. No supported write path can produce
   * one (mem writes `randomUUID`; `import --from-json` validates), so this seeds the row with raw
   * SQL -- exactly the shape a pre-0.2.2 database or a hand-edited row could hold.
   */
  it("drops a fact whose id could forge a line, instead of emitting it into the bare id= field", async () => {
    seedFacts(dbPath, [
      {
        id: "forged\n" + "pref  fresh=affirmed  id=injected  display=\"attacker controlled\"",
        text: "carrier fact for the forged id",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "pref-legit",
        text: "a normally-addressable fact alongside it",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHintFormat({ root, dbPath });

    // The well-formed neighbour still surfaces -- the drop is targeted, not a fail-closed sweep.
    expect(result.lines.some((line) => line.includes("id=pref-legit"))).toBe(true);
    // Nothing the forged id carried reaches the output, on any line.
    expect(result.lines.some((line) => line.includes("id=injected"))).toBe(false);
    expect(result.lines.some((line) => line.includes("attacker controlled"))).toBe(false);
    // And no emitted line carries an embedded newline, which is what forgery needs.
    for (const line of result.lines) {
      expect(line).not.toContain("\n");
    }
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

    expect(result.lines).toHaveLength(2); // fact-line + TGMEM/2's shared footer-line
    expect(result.lines[0]).toContain("id=unrelated-1");
    expect(result.lines.some((line) => line.includes("tie-a") || line.includes("tie-b"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: the seam is a library entry point, not a CLI sub-path ───────────────────────────────────────────────────────────────────────────

describe("buildHintFormat as a long-lived embedder would call it", () => {
  let workDir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mem-seam-embedder-"));
    root = join(workDir, "project");
    mkdirSync(root, { recursive: true });
    dbPath = join(workDir, "mem.db");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function seedAnchoredFact(): void {
    seedFacts(dbPath, [
      {
        id: "anchored-1",
        text: "uses pnpm not npm",
        kind: "preference",
        subject: "package-manager",
        value: "pnpm",
        scope: "global",
        source_type: "user",
        captured_at: new Date().toISOString(),
        anchor: "file-exists pnpm-lock.yaml",
        status: "active",
      },
    ]);
  }

  it("re-evaluates anchors on every call instead of serving a verdict memoized by an earlier one", async () => {
    seedAnchoredFact();
    const lockfile = join(root, "pnpm-lock.yaml");
    writeFileSync(lockfile, "x");

    const first = await buildHintFormat({ root, dbPath });
    expect(first.lines[0]).toContain("fresh=affirmed");

    rmSync(lockfile);

    // The anchor memo is scoped to the process, which is exactly one query for the `mem` CLI but
    // unbounded for an embedder holding this module. Without a per-call reset the first verdict was
    // served forever, no matter what happened on disk afterwards.
    // Re-read, the anchor now contradicts the fact, which `--hint-format` drops entirely rather
    // than emitting as a caveated line.
    const second = await buildHintFormat({ root, dbPath });
    expect(second.lines.some((line) => line.includes("anchored-1"))).toBe(false);
  });

  it("brings the storage schema up to date on a database the mem CLI has never opened", async () => {
    seedAnchoredFact();
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");

    const result = await buildHintFormat({ root, dbPath });
    expect(result.lines[0]).toContain("id=anchored-1");

    // `openDb` alone does not guarantee the storage-owned columns exist; reading a fact through a
    // connection that skipped `ensureStorageSchema` worked only by accident of which columns this
    // path happens to select today.
    const db = openDb(dbPath);
    const columns = db.prepare("PRAGMA table_info(facts)").all() as { name: string }[];
    const names = columns.map((column) => column.name);
    db.close();
    expect(names).toContain("epoch");
    expect(names).toContain("status_changed_at");
    expect(names).toContain("prior_status");
  });
});
