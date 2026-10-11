import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { captureExplicit, captureSuggested } from "../src/capture.js";
import { getFactById, listSourcesForFact, openStorage } from "../src/storage.js";
import { extractMarkdownBullets, importFromMarkdown, MarkdownImportError, planImportFromMarkdown } from "../src/import.js";
import { markerEnd, markerStart, SHARED_BLOCK_END, sharedMarkerStart } from "../src/wiring.js";

// ─────────────────────────────────────────────────────────────────────────── extractMarkdownBullets (pure, no disk) ───────────────────────────────────────────────────────────────────────────

describe("extractMarkdownBullets", () => {
  it("extracts top-level `-` and `*` bullets with 1-based line numbers", () => {
    const bullets = extractMarkdownBullets(["# Heading", "- first bullet", "* second bullet", "not a bullet"].join("\n"));
    expect(bullets).toEqual([
      { text: "first bullet", line: 2, rawLine: "- first bullet" },
      { text: "second bullet", line: 3, rawLine: "* second bullet" },
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

  it("does not let a stray `~~~` line close a ``` fence (backtick and tilde fences don't cross-close)", () => {
    const bullets = extractMarkdownBullets(
      [
        "- real bullet before",
        "```",
        "- fake bullet inside backtick fence",
        "~~~",
        "- still inside the backtick fence even after the stray tilde line",
        "```",
        "- real bullet after",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["real bullet before", "real bullet after"]);
  });

  it("still tracks a genuine tilde-fenced block correctly alongside an unrelated backtick fence", () => {
    const bullets = extractMarkdownBullets(
      [
        "- real bullet before",
        "~~~",
        "- fake bullet inside tilde fence",
        "~~~",
        "- real bullet between fences",
        "```",
        "- fake bullet inside backtick fence",
        "```",
        "- real bullet after",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["real bullet before", "real bullet between fences", "real bullet after"]);
  });

  it("skips a shared mem integration block (start through end marker) and keeps bullets outside it", () => {
    const bullets = extractMarkdownBullets(
      [
        "- before the block",
        sharedMarkerStart(["codex", "opencode"]),
        "## Memory",
        "- run `mem remember` whenever a preference is stated",
        "```",
        "- fenced bullet inside the block",
        "```",
        SHARED_BLOCK_END,
        "- after the block",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["before the block", "after the block"]);
  });

  it("skips a per-tool mem integration block, ending only at that tool's own end marker", () => {
    const bullets = extractMarkdownBullets(
      [markerStart("claude-code"), "- inside the per-tool block", markerEnd("claude-code"), "- after the block"].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["after the block"]);
  });

  it("does not start a skip for mem markers inside a fenced code block", () => {
    const bullets = extractMarkdownBullets(
      ["```", sharedMarkerStart(["codex"]), "- fence content", "```", "- real bullet after the fence", "```", SHARED_BLOCK_END, "```", "- last bullet"].join(
        "\n"
      )
    );
    expect(bullets.map((b) => b.text)).toEqual(["real bullet after the fence", "last bullet"]);
  });

  it("joins indented continuation lines into the bullet, keeping the first line number", () => {
    const bullets = extractMarkdownBullets(
      ["# Rules", "- always run the linter", "  before every commit,", "    including docs-only ones.", "- next bullet"].join("\n")
    );
    expect(bullets).toEqual([
      {
        text: "always run the linter before every commit, including docs-only ones.",
        line: 2,
        rawLine: "- always run the linter before every commit, including docs-only ones.",
      },
      { text: "next bullet", line: 5, rawLine: "- next bullet" },
    ]);
  });

  it("does not join a non-indented line, or an indented line after a blank line, a heading or a fence", () => {
    const bullets = extractMarkdownBullets(
      [
        "- first bullet",
        "not indented prose",
        "- second bullet",
        "",
        "  indented after a blank line",
        "- third bullet",
        "## Heading",
        "  indented after a heading",
        "- fourth bullet",
        "```",
        "```",
        "  indented after a fence",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["first bullet", "second bullet", "third bullet", "fourth bullet"]);
  });

  it("ends the open bullet at an indented numbered-list line instead of joining it", () => {
    const bullets = extractMarkdownBullets(["- install steps", "  1. run the installer", "  2) restart the shell", "  and then verify"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["install steps"]);
  });

  it("keeps importing after an orphan mem block start marker with no end marker", () => {
    const bullets = extractMarkdownBullets(["- before", sharedMarkerStart(["codex"]), "- after the orphan", "- also after"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["before", "after the orphan", "also after"]);
  });

  it("imports the bullets between an orphan start and a later complete block, and still skips that block", () => {
    const bullets = extractMarkdownBullets(
      [
        sharedMarkerStart(["codex"]),
        "- between the markers",
        sharedMarkerStart(["codex", "opencode"]),
        "- inside the real block",
        SHARED_BLOCK_END,
        "- after the block",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["between the markers", "after the block"]);
  });

  it("imports the bullets after a mem block start whose fence is never closed", () => {
    const bullets = extractMarkdownBullets(["- before", markerStart("claude-code"), "- after the start", "```", markerEnd("claude-code")].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["before", "after the start"]);
  });

  it("handles CRLF input: skips a mem block and still joins a wrapped bullet", () => {
    const bullets = extractMarkdownBullets(
      ["- wrapped bullet", "  continues here", markerStart("claude-code"), "- inside", markerEnd("claude-code"), "- after"].join("\r\n")
    );
    expect(bullets).toEqual([
      { text: "wrapped bullet continues here", line: 1, rawLine: "- wrapped bullet continues here" },
      { text: "after", line: 6, rawLine: "- after" },
    ]);
  });

  it("imports bullets after a shared mem block that opens and closes on one line", () => {
    const bullets = extractMarkdownBullets([`${sharedMarkerStart(["codex"])}${SHARED_BLOCK_END}`, "- real rule"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["real rule"]);
  });

  it("imports bullets after a per-tool mem block that opens and closes on one line", () => {
    const bullets = extractMarkdownBullets([`${markerStart("claude-code")}${markerEnd("claude-code")}`, "- real rule"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["real rule"]);
  });

  it("handles CRLF input: a one-line mem block does not swallow the bullets after it", () => {
    const bullets = extractMarkdownBullets([`${sharedMarkerStart(["codex"])}${SHARED_BLOCK_END}`, "- real rule"].join("\r\n"));
    expect(bullets).toEqual([{ text: "real rule", line: 2, rawLine: "- real rule" }]);
  });

  it("does not end a mem block at an end marker inside a fenced example within it", () => {
    const bullets = extractMarkdownBullets(
      [
        "- before",
        sharedMarkerStart(["codex"]),
        "```",
        SHARED_BLOCK_END,
        "```",
        "- still inside the block",
        SHARED_BLOCK_END,
        "- after",
      ].join("\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["before", "after"]);
  });

  it("handles CRLF input: a fenced end marker inside a mem block does not end the block", () => {
    const bullets = extractMarkdownBullets(
      [markerStart("claude-code"), "~~~", markerEnd("claude-code"), "~~~", "- still inside", markerEnd("claude-code"), "- after"].join("\r\n")
    );
    expect(bullets.map((b) => b.text)).toEqual(["after"]);
  });

  it("ends the open bullet at an indented heading instead of gluing the heading onto it", () => {
    const bullets = extractMarkdownBullets(["- run npm test", "  ## Deployment", "  deploy on Fridays"].join("\n"));
    expect(bullets).toEqual([{ text: "run npm test", line: 1, rawLine: "- run npm test" }]);
  });

  it("still ends the open bullet at a column-0 heading and tracks it for the structural-heading rule", () => {
    const bullets = extractMarkdownBullets(["- run npm test", "## Architecture", "  - nested layout note", "- top-level rule"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["run npm test", "top-level rule"]);
  });

  it("keeps a heading indented 4+ spaces as a continuation line", () => {
    const bullets = extractMarkdownBullets(["- run npm test", "    ## literal text"].join("\n"));
    expect(bullets.map((b) => b.text)).toEqual(["run npm test ## literal text"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────── planImportFromMarkdown (dry-run, DB-free) ───────────────────────────────────────────────────────────────────────────

describe("planImportFromMarkdown", () => {
  it("produces dry_run outcomes for every candidate without opening a database (the CLI --dry-run path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-plan-"));
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, ["# Notes", "- Always use pnpm, never npm.", "- Prefer tabs over spaces."].join("\n"), "utf8");
    try {
      const result = planImportFromMarkdown({ path });
      expect(result.candidates).toHaveLength(2);
      expect(result.outcomes.every((o) => o.status === "dry_run")).toBe(true);
      expect(result.outcomes.map((o) => o.candidate.text)).toEqual([
        "Always use pnpm, never npm.",
        "Prefer tabs over spaces.",
      ]);
      expect(result.candidates.every((c) => c.sourceRef.startsWith(resolve(path)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws MarkdownImportError with clear message when the file does not exist", () => {
    const path = "/nonexistent/path/that/does/not/exist/CLAUDE.md";
    expect(() => planImportFromMarkdown({ path })).toThrow(MarkdownImportError);
    try {
      planImportFromMarkdown({ path });
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownImportError);
      expect((error as Error).message).toContain("file not found");
      expect((error as Error).message).toContain("nonexistent");
      expect((error as Error).message).toContain("CLAUDE.md");
    }
  });

  it("throws MarkdownImportError with clear message when the path is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-plan-"));
    try {
      expect(() => planImportFromMarkdown({ path: dir })).toThrow(MarkdownImportError);
      planImportFromMarkdown({ path: dir });
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownImportError);
      expect((error as Error).message).toContain("is a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("imports a hard-wrapped bullet as one fact with the full text, sourced at its first line, and skips mem's own block", () => {
    writeFileSync(
      mdPath,
      [
        "- Always run the full suite",
        "  before tagging a release.",
        sharedMarkerStart(["codex"]),
        "- run `mem remember` when a preference is stated",
        SHARED_BLOCK_END,
      ].join("\n"),
      "utf8"
    );
    const result = importFromMarkdown(db, { path: mdPath, root });

    const imported = result.outcomes.filter((o) => o.status === "imported");
    expect(imported).toHaveLength(1);
    const outcome = imported[0];
    if (outcome?.status !== "imported") {
      throw new Error("expected an imported outcome");
    }
    expect(outcome.fact.text).toBe("Always run the full suite before tagging a release.");
    expect(outcome.fact.source_ref).toBe(`${resolve(mdPath)}:1`);
    expect(listSourcesForFact(db, outcome.fact.id)[0]?.excerpt).toContain("Always run the full suite before tagging a release.");
  });

  it("reports a wrapped bullet whose joined text exceeds the capture length limit as skipped_error, not imported truncated", () => {
    writeFileSync(mdPath, [`- ${"a".repeat(300)}`, `  ${"b".repeat(300)}`].join("\n"), "utf8");
    const result = importFromMarkdown(db, { path: mdPath, root });

    expect(result.candidates[0]?.text).toHaveLength(601);
    expect(result.outcomes.map((o) => o.status)).toEqual(["skipped_error"]);
    const count = db.prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    expect(count.c).toBe(0);
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

  it("skips a bullet matching an already-known active fact in the same project (skipped_known, not imported)", () => {
    captureExplicit(db, { text: "Always use pnpm, never npm.", kind: "preference", scope: "project", root });

    const result = importFromMarkdown(db, { path: mdPath, root });
    const known = result.outcomes.find((o) => o.candidate.text === "Always use pnpm, never npm.");
    expect(known?.status).toBe("skipped_known");
    const imported = result.outcomes.filter((o) => o.status === "imported");
    expect(imported.map((o) => o.candidate.text)).toEqual(["Prefer tabs over spaces in this repo."]);
  });

  it("records a sighting on a bullet matching an already-pending suggestion in the same project, without changing its status", () => {
    const { fact: existing } = captureSuggested(db, { text: "Always use pnpm, never npm.", kind: "preference", scope: "project", root });
    expect(existing.status).toBe("pending");
    expect(listSourcesForFact(db, existing.id)).toHaveLength(0);

    const result = importFromMarkdown(db, { path: mdPath, root });
    const known = result.outcomes.find((o) => o.candidate.text === "Always use pnpm, never npm.");
    expect(known?.status).toBe("skipped_known");
    const imported = result.outcomes.filter((o) => o.status === "imported");
    expect(imported.map((o) => (o.status === "imported" ? o.candidate.text : ""))).toEqual(["Prefer tabs over spaces in this repo."]);

    const reread = getFactById(db, existing.id);
    expect(reread?.status).toBe("pending");
    expect(reread?.sightings).toBe(1);
    expect(listSourcesForFact(db, existing.id)).toHaveLength(1);
  });

  it("does not skip a bullet matching a fact bound to an unrelated project root", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "mem-import-other-root-"));
    try {
      captureExplicit(db, { text: "Always use pnpm, never npm.", kind: "preference", scope: "project", root: otherRoot });

      const result = importFromMarkdown(db, { path: mdPath, root });
      const outcome = result.outcomes.find((o) => o.candidate.text === "Always use pnpm, never npm.");
      expect(outcome?.status).toBe("imported");
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("re-importing an unchanged file still reports skipped_duplicate, not skipped_known", () => {
    importFromMarkdown(db, { path: mdPath, root });
    const second = importFromMarkdown(db, { path: mdPath, root });
    expect(second.outcomes.every((o) => o.status === "skipped_duplicate")).toBe(true);
  });

  // Defect 5: --from-md path has no file size cap
  it("rejects markdown files over the size limit (50 MB), matching the JSON import path", () => {
    const tempFile = join(tmpdir(), `test-oversized-${Date.now()}.md`);

    try {
      // Create a file larger than 50 MB (50_000_000 bytes)
      const sizeLimit = 50_000_000;
      const oversized = "- " + "x".repeat(sizeLimit + 1);
      writeFileSync(tempFile, oversized);

      expect(() => {
        planImportFromMarkdown({ path: tempFile });
      }).toThrow(/too large/i);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
});
