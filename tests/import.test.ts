import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { openStorage } from "../src/storage.js";
import { extractMarkdownBullets, importFromMarkdown } from "../src/import.js";

// ─────────────────────────────────────────────────────────────────────────── extractMarkdownBullets (pure, no disk) ───────────────────────────────────────────────────────────────────────────

describe("extractMarkdownBullets", () => {
  it("extracts top-level `-` and `*` bullets with 1-based line numbers", () => {
    const bullets = extractMarkdownBullets(["# Heading", "- first bullet", "* second bullet", "not a bullet"].join("\n"));
    expect(bullets).toEqual([
      { text: "first bullet", line: 2 },
      { text: "second bullet", line: 3 },
    ]);
  });

  it("skips non-bullet prose and blank lines", () => {
    const bullets = extractMarkdownBullets(["Some paragraph text.", "", "Another line, still not a bullet."].join("\n"));
    expect(bullets).toEqual([]);
  });

  it("skips bullet-shaped lines inside fenced code blocks", () => {
    const bullets = extractMarkdownBullets(
      ["- real bullet", "```", "- fake bullet inside a code fence", "```", "- another real bullet"].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["real bullet", "another real bullet"]);
  });

  it("skips nested bullets under an obviously structural heading (Architecture / File Structure)", () => {
    const bullets = extractMarkdownBullets(
      [
        "## Architecture",
        "  - src/foo.ts owns X",
        "  - src/bar.ts owns Y",
        "## Preferences",
        "- always use pnpm",
        "  - nested preference detail",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["always use pnpm", "nested preference detail"]);
  });

  it("still imports top-level bullets directly under a structural heading", () => {
    const bullets = extractMarkdownBullets(["## File Structure", "- keep configs in the root directory"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["keep configs in the root directory"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────── importFromMarkdown (DB-backed) ───────────────────────────────────────────────────────────────────────────

let root: string;
let db: Database.Database;
let mdPath: string;

const FIXTURE = [
  "# CLAUDE.md",
  "",
  "## Preferences",
  "- Always use pnpm, never npm.",
  "- Prefer tabs over spaces in this repo.",
  "",
  "## Architecture",
  "  - src/cli.ts owns argument parsing",
  "",
  "```",
  "- this looks like a bullet but is inside a code fence",
  "```",
  "",
  "Not a bullet, just prose.",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-import-test-"));
  db = openStorage(join(root, "mem.db"));
  mdPath = join(root, "CLAUDE.md");
  writeFileSync(mdPath, FIXTURE, "utf8");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("importFromMarkdown", () => {
  it("imports qualifying bullets as pending, derived facts through the same trust path as captureSuggested", () => {
    const result = importFromMarkdown(db, { path: mdPath, root });

    const imported = result.outcomes.filter((o) => o.status === "imported");
    expect(imported).toHaveLength(2);
    for (const outcome of imported) {
      if (outcome.status !== "imported") {continue;}
      expect(outcome.fact.status).toBe("pending");
      expect(outcome.fact.source_type).toBe("derived");
      expect(outcome.fact.source_ref).toBe(outcome.candidate.sourceRef);
      expect(outcome.fact.source_ref).toContain(resolve(mdPath));
    }
    expect(imported.map((o) => (o.status === "imported" ? o.candidate.text : ""))).toEqual([
      "Always use pnpm, never npm.",
      "Prefer tabs over spaces in this repo.",
    ]);
  });

  it("skips non-bullet content and fenced/nested-structural bullets (only 2 candidates from the fixture)", () => {
    const result = importFromMarkdown(db, { path: mdPath, root, dryRun: true });
    expect(result.candidates).toHaveLength(2);
  });

  it("--dry-run reports candidates but writes nothing", () => {
    const before = db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    const result = importFromMarkdown(db, { path: mdPath, root, dryRun: true });

    expect(result.outcomes.every((o) => o.status === "dry_run")).toBe(true);
    expect(result.outcomes).toHaveLength(2);

    const after = db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("re-importing the same file does not create duplicate facts", () => {
    importFromMarkdown(db, { path: mdPath, root });
    const countAfterFirst = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;
    expect(countAfterFirst).toBe(2);

    const second = importFromMarkdown(db, { path: mdPath, root });
    const countAfterSecond = (db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number }).c;

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.outcomes.every((o) => o.status === "skipped_duplicate")).toBe(true);
  });

  it("never produces an active fact -- every imported candidate lands pending regardless of caller options", () => {
    const result = importFromMarkdown(db, { path: mdPath, root, kind: "decision" });
    const imported = result.outcomes.filter((o) => o.status === "imported");
    expect(imported.length).toBeGreaterThan(0);
    for (const outcome of imported) {
      if (outcome.status !== "imported") {continue;}
      expect(outcome.fact.status).toBe("pending");
    }
  });
});
