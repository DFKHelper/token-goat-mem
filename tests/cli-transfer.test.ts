/** End-to-end CLI tests for moving facts in and out: import from markdown and JSON, and export. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRememberedId, runCli } from "./support/cli.js";
import { resolveDbPath } from "../src/db.js";
import { insertFact, markFactsSurfaced, openStorage, setFactStatus } from "../src/storage.js";


let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── import --from-md ───────────────────────────────────────────────────────────────────────────

describe("import --from-md (advisory CLAUDE.md -> mem migration, S9 trust path)", () => {
  function writeFixture(contents: string): string {
    const path = join(home, "CLAUDE.md");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  it("imports qualifying bullets as pending facts, confirmable only via `mem review --promote`", async () => {
    const path = writeFixture(["## Preferences", "- Always use pnpm, never npm.", "- Prefer tabs over spaces."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 2 of 2 candidate fact(s)");
    expect(result.stdout).toContain("never auto-promoted -- confirm each via `mem review --promote <id>`");

    const listed = await runCli(["list", "--status", "pending"]);
    expect(listed.stdout).toContain("Always use pnpm, never npm.");
    expect(listed.stdout).toContain("Prefer tabs over spaces.");
    expect(listed.stdout).not.toContain("[preference/active]");

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 2, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("skips non-bullet content", async () => {
    const path = writeFixture(["Just a paragraph.", "", "Another sentence, no bullets here."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no qualifying bullets found");

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });

  it("--from-md --scope path --path <file> binds every imported bullet to that file", async () => {
    const path = writeFixture(["- auth.ts owns migrations."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--scope", "path", "--path", "src/auth.ts"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 1 of 1 candidate fact(s)");

    const listed = await runCli(["list", "--status", "pending", "--json"]);
    const envelope = JSON.parse(listed.stdout) as { facts: readonly { scopeRoot: string | null }[] };
    expect(envelope.facts[0]?.scopeRoot).toBe(join(home, "src", "auth.ts"));
  });

  it("--from-md --scope path --path <escaping-relative-path> skips every bullet with a per-item error, not bound outside --root", async () => {
    const path = writeFixture(["- auth.ts owns migrations."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--scope", "path", "--path", "../../etc/passwd"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(result.stdout).toContain("resolves outside --root");

    const listed = await runCli(["list", "--status", "pending", "--json"]);
    const envelope = JSON.parse(listed.stdout) as { facts: readonly unknown[] };
    expect(envelope.facts).toHaveLength(0);
  });

  it("--from-md --scope path without --path exits 1 with a pinned message", async () => {
    const path = writeFixture(["- auth.ts owns migrations."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--scope", "path"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--scope path requires --path <file-or-dir>");
  });

  it("--dry-run reports candidates without writing any facts", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would import 1 of 1 candidate fact(s)");
    expect(result.stdout).toContain("nothing written");

    // Regression: --dry-run previously routed through openDb (mkdir + schema init) even though it never wrote a fact, so it silently created mem.db despite claiming not to write anything.
    expect(existsSync(join(home, "mem.db"))).toBe(false);

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });

  it("re-importing the same file does not create duplicate facts", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));

    const first = await runCli(["import", "--from-md", path, "--root", home]);
    expect(first.stdout).toContain("imported 1 of 1 candidate fact(s)");

    const second = await runCli(["import", "--from-md", path, "--root", home]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(second.stdout).toContain("skipped (duplicate)");

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("skips a bullet matching a fact the user already remembered themselves (skipped_known, not a new pending duplicate)", async () => {
    await runCli(["remember", "Backups run nightly at 2am.", "--kind", "fact", "--scope", "project", "--root", home]);
    const path = writeFixture(["- Backups run nightly at 2am."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(result.stdout).toContain("skipped (already known)");

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 0, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("--dry-run cannot predict a skipped_known match and discloses that limitation", async () => {
    await runCli(["remember", "Backups run nightly at 2am.", "--kind", "fact", "--scope", "project", "--root", home]);
    const path = writeFixture(["- Backups run nightly at 2am."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would import 1 of 1 candidate fact(s)");
    expect(result.stdout).toContain("note: matches against facts already in the store are not checked in a dry run");
  });

  it("promoting an imported fact goes through the exact same `mem review --promote` path as any other pending fact", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));
    const imported = await runCli(["import", "--from-md", path, "--root", home]);
    const match = /imported\s+\S+\s+(\S+)\s+"/u.exec(imported.stdout);
    expect(match?.[1]).toBeDefined();
    const id = match?.[1] ?? "";

    const promoted = await runCli(["review", "--promote", id]);
    expect(promoted.exitCode).toBe(0);
    expect(promoted.stdout.trimEnd().split("\n")[0]).toBe(`promoted ${id}`);
    // An imported bullet is text, not a keyed claim, so promotion names the gap and the one command that closes it rather than leaving the fact quietly unsupersedable.
    expect(promoted.stdout).toContain(`mem edit ${id} --subject <key> --value <value>`);

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("status: active");
  });

  it("exits with code 1 (user error) when the --from-md file does not exist", async () => {
    const result = await runCli(["import", "--from-md", "/nonexistent/path/CLAUDE.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mem: ");
    expect(result.stderr).toContain("file not found");
  });

  it("exits with code 1 (user error) when the --from-md path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-dir-"));
    try {
      const result = await runCli(["import", "--from-md", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mem: ");
      expect(result.stderr).toContain("is a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires exactly one of --from-md or --from-json", async () => {
    // Neither flag given.
    const neither = await runCli(["import"]);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain("requires exactly one of --from-md or --from-json");

    // Both flags given.
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));
    const both = await runCli(["import", "--from-md", path, "--from-json", path, "--root", home]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("requires exactly one of --from-md or --from-json");
  });

  it("records a source excerpt naming the file, line, and raw bullet text", async () => {
    const path = writeFixture(["## Preferences", "- Always use pnpm, never npm."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string }[] }).facts[0]?.id ?? "";
    const shown = await runCli(["show", id, "--json"]);
    const envelope = JSON.parse(shown.stdout) as { sources: { excerpt: string }[] };
    expect(envelope.sources).toHaveLength(1);
    // `<path relative to root>:<line>: <raw bullet line>` -- the resolved absolute path never appears, and the marker/whitespace the candidate's own `text` field has stripped is intact.
    expect(envelope.sources[0]?.excerpt).toBe("CLAUDE.md:2: - Always use pnpm, never npm.");
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem export / mem import --from-json ───────────────────────────────────────────────────────────────────────────

interface ExportedFact {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  readonly captured_at: string;
  readonly last_surfaced_at: string | null;
  readonly prior_status: string | null;
  readonly superseded_by?: string | null;
}

interface ExportEnvelope {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly facts: readonly ExportedFact[];
}

describe("mem export", () => {
  it("exports schemaVersion 1, a valid exportedAt, and every seeded fact across statuses", async () => {
    const remembered = await runCli([
      "remember",
      "uses pnpm not npm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    const activeId = extractRememberedId(remembered);

    const suggested = await runCli(["suggest", "maybe prefers dark mode", "--kind", "preference"]);
    const pendingId = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout)?.[1] as string;

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);

    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(new Date(envelope.exportedAt).toISOString()).toBe(envelope.exportedAt);

    const byId = new Map(envelope.facts.map((fact) => [fact.id, fact]));
    expect(byId.has(activeId)).toBe(true);
    expect(byId.get(activeId)?.status).toBe("active");
    expect(byId.get(activeId)?.text).toBe("uses pnpm not npm");

    expect(byId.has(pendingId)).toBe(true);
    expect(byId.get(pendingId)?.status).toBe("pending");
  });

  it("--status filters which facts are exported", async () => {
    const remembered = await runCli([
      "remember",
      "uses pnpm not npm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    const activeId = extractRememberedId(remembered);

    const suggested = await runCli(["suggest", "maybe prefers dark mode", "--kind", "preference"]);
    const pendingId = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout)?.[1] as string;

    const exported = await runCli(["export", "--status", "active"]);
    expect(exported.exitCode).toBe(0);

    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const byId = new Map(envelope.facts.map((fact) => [fact.id, fact]));
    expect(byId.has(activeId)).toBe(true);
    expect(byId.has(pendingId)).toBe(false);
  });

  it("a store with no superseded facts exports byte-identical output to before superseded_by existed (modulo exportedAt)", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    await runCli(["remember", "the deploy target is fly.io", "--kind", "fact"]);

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const envelope = JSON.parse(exported.stdout) as { exportedAt: string; facts: readonly Record<string, unknown>[] };
    for (const fact of envelope.facts) {
      expect(fact["status"]).not.toBe("superseded");
      expect(Object.prototype.hasOwnProperty.call(fact, "superseded_by")).toBe(false);
    }
  });
});

describe("mem export --format md", () => {
  it("defaults to json: --format json output is byte-identical to the pre-existing no-flag output (modulo exportedAt)", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);

    const bare = await runCli(["export"]);
    const explicit = await runCli(["export", "--format", "json"]);
    expect(bare.exitCode).toBe(0);
    expect(explicit.exitCode).toBe(0);
    // exportedAt is `new Date().toISOString()` at call time -- the one field guaranteed to differ between two invocations. Blank it out in both before comparing so the rest of the envelope (including key order, from JSON.stringify(..., null, 2)) is asserted byte-for-byte.
    const normalize = (stdout: string): string => stdout.replace(/"exportedAt": ".*"/u, '"exportedAt": "<normalized>"');
    expect(normalize(explicit.stdout)).toBe(normalize(bare.stdout));
  });

  it("round-trips fact text through `mem import --from-md` into a fresh store", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    await runCli(["remember", "the database server is postgres", "--kind", "fact"]);

    const exported = await runCli(["export", "--format", "md"]);
    expect(exported.exitCode).toBe(0);

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-md-"));
    const mdPath = join(exportDir, "export.md");
    writeFileSync(mdPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-md-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-md", mdPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 2 of 2 candidate fact(s)");

      const listed = await runCli(["list", "--status", "pending"]);
      expect(listed.stdout).toContain("uses pnpm not npm");
      expect(listed.stdout).toContain("the database server is postgres");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("collapses an embedded newline to one bullet with no text lost", async () => {
    await runCli(["remember", "line one\nline two", "--kind", "fact"]);

    const exported = await runCli(["export", "--format", "md"]);
    expect(exported.exitCode).toBe(0);
    // The whole fact must appear on a single "- " line -- two separate lines would mean the second half (BULLET_RE is single-line) is either lost or reads back as unrelated non-bullet content.
    expect(exported.stdout).toContain("- line one line two");

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-md-nl-"));
    const mdPath = join(exportDir, "export.md");
    writeFileSync(mdPath, exported.stdout, "utf8");
    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-md-nl-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-md", mdPath]);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");
      const listed = await runCli(["list", "--status", "pending"]);
      expect(listed.stdout).toContain("line one line two");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("a fact containing a code fence does not swallow the bullets that follow it", async () => {
    await runCli(["remember", "run ```npm test``` before pushing", "--kind", "preference"]);
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);

    const exported = await runCli(["export", "--format", "md"]);
    expect(exported.exitCode).toBe(0);

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-md-fence-"));
    const mdPath = join(exportDir, "export.md");
    writeFileSync(mdPath, exported.stdout, "utf8");
    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-md-fence-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-md", mdPath]);
      // Both bullets must import: if the fence had opened a real code block, extractMarkdownBullets would have swallowed everything after it, including "uses pnpm not npm".
      expect(imported.stdout).toContain("imported 2 of 2 candidate fact(s)");
      const listed = await runCli(["list", "--status", "pending"]);
      expect(listed.stdout).toContain("uses pnpm not npm");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("a fact whose text starts with `-` imports back with its leading character intact", async () => {
    // Seeded directly via insertFact rather than `mem remember`: commander parses a leading-dash argv element as an unknown option, which is a CLI arg-parsing quirk unrelated to the round-trip behavior this test targets.
    const seedDb = openStorage(resolveDbPath());
    insertFact(seedDb, { text: "-1 is the sentinel for 'no result'", kind: "fact", scope: "global", source_type: "user" });
    seedDb.close();

    const exported = await runCli(["export", "--format", "md"]);
    expect(exported.exitCode).toBe(0);

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-md-dash-"));
    const mdPath = join(exportDir, "export.md");
    writeFileSync(mdPath, exported.stdout, "utf8");
    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-md-dash-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-md", mdPath]);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");
      const listed = await runCli(["list", "--status", "pending"]);
      expect(listed.stdout).toContain("-1 is the sentinel for 'no result'");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("applies --kind and --scope filters identically to json and md output", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    await runCli(["remember", "the database server is postgres", "--kind", "fact"]);

    const md = await runCli(["export", "--format", "md", "--kind", "fact"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout).toContain("the database server is postgres");
    expect(md.stdout).not.toContain("uses pnpm not npm");
    expect(md.stdout).toContain("## Facts");
    expect(md.stdout).not.toContain("## Preferences");
  });

  it("an empty result set produces a valid header comment with no dangling heading", async () => {
    const exported = await runCli(["export", "--format", "md", "--kind", "correction"]);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain("<!--");
    expect(exported.stdout).not.toContain("##");

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-md-empty-"));
    const mdPath = join(exportDir, "export.md");
    writeFileSync(mdPath, exported.stdout, "utf8");
    const imported = await runCli(["import", "--from-md", mdPath]);
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toContain("no qualifying bullets found");
    rmSync(exportDir, { recursive: true, force: true });
  });

  it("rejects an unrecognized --format value", async () => {
    const result = await runCli(["export", "--format", "yaml"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --format "yaml"');
  });
});

describe("mem import --from-json (full-fidelity round-trip)", () => {
  it("round-trips a fact -- including id, status, confidence, and captured_at -- into a fresh store", async () => {
    const remembered = await runCli([
      "remember",
      "uses pnpm not npm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    const id = extractRememberedId(remembered);

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const originalFact = envelope.facts.find((fact) => fact.id === id);
    expect(originalFact).toBeDefined();

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`id: ${id}`);
      expect(shown.stdout).toContain("status: active");
      expect(shown.stdout).toContain("text: uses pnpm not npm");
      expect(shown.stdout).toContain("subject: package-manager");
      expect(shown.stdout).toContain("value: pnpm");
      expect(shown.stdout).toContain(`confidence: ${originalFact?.confidence}`);
      expect(shown.stdout).toContain(`captured_at: ${originalFact?.captured_at}`);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("carries a superseded fact's supersession edge through export/import, so `mem show` names the winner instead of printing the unknown caveat", async () => {
    const first = await runCli(["remember", "the database server is postgres", "--kind", "fact", "--subject", "db", "--value", "postgres"]);
    const loserId = extractRememberedId(first);
    const second = await runCli(["remember", "the database server is mysql", "--kind", "fact", "--subject", "db", "--value", "mysql"]);
    const winnerId = extractRememberedId(second);
    await runCli(["epoch", "--gc"]);

    // Confirm the edge is known pre-round-trip, so the assertion below is actually exercising a regression rather than a store that never knew the cause to begin with.
    const before = await runCli(["show", loserId]);
    expect(before.stdout).toContain(`superseded_by: ${winnerId}`);

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const loserExport = envelope.facts.find((fact) => fact.id === loserId);
    expect(loserExport?.superseded_by).toBe(winnerId);

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);

      const shown = await runCli(["show", loserId]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("status: superseded");
      // The winner is right there in the imported store, and the exported edge named it, so the "unknown" fallback must not fire -- `mem show` now names the winner directly.
      expect(shown.stdout).not.toContain("superseded_by: unknown");
      expect(shown.stdout).toContain(`superseded_by: ${winnerId}`);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("round-trips last_surfaced_at and prior_status -- a restored fact keeps looking surfaced and undo-able", async () => {
    const remembered = await runCli(["remember", "the deploy target is fly.io", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const surfacedAt = "2026-01-15T00:00:00.000Z";
    const db = openStorage(resolveDbPath());
    // A genuine status transition so `prior_status` moves off its default NULL, then a stamp so `last_surfaced_at` is non-null too -- both are the signals listStaleUnsurfacedFacts reads.
    setFactStatus(db, id, "pinned");
    setFactStatus(db, id, "active");
    markFactsSurfaced(db, [id], surfacedAt);
    db.close();

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const originalFact = envelope.facts.find((fact) => fact.id === id);
    expect(originalFact?.last_surfaced_at).toBe(surfacedAt);
    expect(originalFact?.prior_status).toBe("pinned");

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const shown = await runCli(["show", id, "--json"]);
      expect(shown.exitCode).toBe(0);
      const shownEnvelope = JSON.parse(shown.stdout) as { fact: ExportedFact };
      expect(shownEnvelope.fact.last_surfaced_at).toBe(surfacedAt);
      expect(shownEnvelope.fact.prior_status).toBe("pinned");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("imports a legacy export envelope that predates last_surfaced_at/prior_status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-export-legacy-"));
    const jsonPath = join(dir, "export.json");
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      facts: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          text: "legacy envelope fact",
          kind: "fact",
          subject: null,
          value: null,
          scope: "global",
          scopeRoot: null,
          source_type: "user",
          source_ref: null,
          captured_at: "2026-01-01T00:00:00.000Z",
          anchor: null,
          status: "active",
          confidence: 1,
          embedding: null,
          // last_surfaced_at/prior_status deliberately absent.
        },
      ],
    };
    writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const shown = await runCli(["show", "22222222-2222-2222-2222-222222222222", "--json"]);
      expect(shown.exitCode).toBe(0);
      const shownEnvelope = JSON.parse(shown.stdout) as { fact: ExportedFact };
      expect(shownEnvelope.fact.last_surfaced_at).toBeNull();
      expect(shownEnvelope.fact.prior_status).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-importing the same export file against the same target is idempotent -- second run reports duplicates, fact count unchanged", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const first = await runCli(["import", "--from-json", jsonPath]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("imported 1 of 1 candidate fact(s)");
      const countAfterFirst = await runCli(["list"]);
      const countLinesFirst = countAfterFirst.stdout.trim().split("\n").length;

      const second = await runCli(["import", "--from-json", jsonPath]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
      expect(second.stdout).toContain("skipped (duplicate)");

      const countAfterSecond = await runCli(["list"]);
      const countLinesSecond = countAfterSecond.stdout.trim().split("\n").length;
      expect(countLinesSecond).toBe(countLinesFirst);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("--dry-run reports candidates without writing any facts, and never creates mem.db", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const result = await runCli(["import", "--from-json", jsonPath, "--dry-run"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("would import 1 of 1 candidate fact(s)");
      expect(result.stdout).toContain("nothing written");
      expect(existsSync(join(targetHome, "mem.db"))).toBe(false);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("--dry-run applies the same root-bounding and secret screening the real import does, and says what it cannot check", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mem-import-root-"));
    await runCli(["remember", "ordinary fact one", "--kind", "fact", "--scope", "project", "--root", projectRoot]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "import.json");

    const envelope = JSON.parse(exported.stdout) as { facts: Record<string, unknown>[] };
    const base = envelope.facts[0] as Record<string, unknown>;
    envelope.facts = [
      base,
      { ...base, id: "33333333-3333-4333-8333-333333333333", text: "fact bound outside the import root", scopeRoot: join(tmpdir(), "some-other-root-xyz") },
      { ...base, id: "44444444-4444-4444-8444-444444444444", text: "the key is AKIAIOSFODNN7EXAMPLE and sk-abcdefghijklmnopqrstuvwxyz012345" },
    ];
    writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const result = await runCli(["import", "--from-json", jsonPath, "--root", projectRoot, "--dry-run"]);
      expect(result.exitCode).toBe(0);

      const lines = result.stdout.split("\n");
      const outsideLine = lines.find((line) => line.includes("fact bound outside the import root"));
      const secretLine = lines.find((line) => line.includes("AKIAIOSFODNN7EXAMPLE"));
      const ordinaryLine = lines.find((line) => line.includes('"ordinary fact one"'));

      // Non-firing guard: a valid candidate is still reported as importable, so the screening above is not just refusing everything.
      expect(ordinaryLine).toBeDefined();
      expect(ordinaryLine).toContain("would-import");

      expect(outsideLine).toBeDefined();
      expect(outsideLine).toContain("would-skip");
      expect(outsideLine).toContain('has a "scopeRoot"');
      expect(outsideLine).toContain("outside the import root");

      expect(secretLine).toBeDefined();
      expect(secretLine).toContain("would-skip");
      expect(secretLine).toContain("refusing to import fact: possible secret detected");
      expect(secretLine).toContain("text: aws-access-key-id");

      expect(result.stdout).toContain("would import 1 of 3 candidate fact(s)");
      // The one refusal a dry run genuinely cannot predict is disclosed rather than implied away.
      expect(result.stdout).toContain("duplicate-id conflicts are not checked in a dry run");
      // Still no store touched.
      expect(existsSync(join(targetHome, "mem.db"))).toBe(false);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("skips a fact with a high-entropy secret value the same way mem remember rejects it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-export-tampered-"));
    const jsonPath = join(dir, "export.json");
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      facts: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          text: "deploy key",
          kind: "fact",
          subject: "deploy-key",
          value: "AKIAABCDEFGHIJKLMNOP",
          scope: "global",
          scopeRoot: null,
          source_type: "user",
          source_ref: null,
          captured_at: new Date().toISOString(),
          anchor: null,
          status: "active",
          confidence: 1,
          embedding: null,
        },
      ],
    };
    writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");

    try {
      const result = await runCli(["import", "--from-json", jsonPath]);
      // Per-fact skip, not a hard command failure: the command still reports success overall (imported 0 of 1), same as a duplicate or a structurally invalid fact.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("imported 0 of 1 candidate fact(s)");
      expect(result.stdout).toContain("secret");

      const listed = await runCli(["list"]);
      expect(listed.stdout.trim()).toBe("no facts stored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with code 1 (user error) when the --from-json file does not exist", async () => {
    const result = await runCli(["import", "--from-json", "/nonexistent/path/export.json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mem: ");
    expect(result.stderr).toContain("file not found");
  });

  it("exits with code 1 (user error) when the --from-json path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-dir-"));
    try {
      const result = await runCli(["import", "--from-json", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mem: ");
      expect(result.stderr).toContain("is a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mem import summary wording (regression: must describe what was actually written)", () => {
  it("does not claim `--from-json` imports landed as pending when their exported status was preserved", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-wording-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-wording-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");
      // The fact is restored active, so the summary must not send the reader to a `mem review` that has nothing to show.
      expect(imported.stdout).toContain("preserving each fact's exported status");
      expect(imported.stdout).not.toContain("as pending");
      expect(imported.stdout).not.toContain("mem review --promote");

      const review = await runCli(["review", "--summary"]);
      expect(review.stdout.trim()).toBe("pending: 0, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("still labels `--from-md` bullets as pending, since those genuinely are", async () => {
    const path = join(home, "NOTES.md");
    writeFileSync(path, ["## Preferences", "- Always use pnpm, never npm."].join("\n"), "utf8");

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("as pending");
    expect(result.stdout).toContain("never auto-promoted -- confirm each via `mem review --promote <id>`");
  });

  it("reports nothing written when every candidate was a duplicate", async () => {
    const path = join(home, "DUPES.md");
    writeFileSync(path, ["## Preferences", "- Always use pnpm, never npm."].join("\n"), "utf8");

    await runCli(["import", "--from-md", path, "--root", home]);
    const second = await runCli(["import", "--from-md", path, "--root", home]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(second.stdout).toContain("no new facts were written");
    expect(second.stdout).not.toContain("as pending");
  });
});

// --- regression: a restored backup is not instantly garbage ---

describe("regression: import --from-json does not restore facts that are already GC-expired", () => {
  it("keeps a superseded fact restored from an old export instead of pruning it on the next gc", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-clock-"));
    const envelopePath = join(dir, "backup.json");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      writeFileSync(
        envelopePath,
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          facts: [
            {
              id,
              text: "an old fact superseded long before this backup was taken",
              kind: "fact",
              subject: null,
              value: null,
              scope: "global",
              scopeRoot: null,
              source_type: "user",
              source_ref: null,
              captured_at: longAgo,
              anchor: null,
              status: "superseded",
              confidence: 1,
              embedding: null,
            },
          ],
        })
      );

      expect((await runCli(["import", "--from-json", envelopePath])).exitCode).toBe(0);
      expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);

      // The 90-day superseded retention window is measured from `status_changed_at`, and the export envelope carries no status timestamp to restore. Starting that clock at the envelope's backdated `captured_at` meant every restored superseded fact arrived with its window already elapsed and was destroyed by the first gc after the restore: silent data loss on the one path the docs recommend for backups.
      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("an old fact superseded long before this backup was taken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── import --captured-at ───────────────────────────────────────────────────────────────────────────

describe("import --from-md --captured-at", () => {
  let mdDir: string;

  function writeMarkdown(): string {
    mdDir = mkdtempSync(join(tmpdir(), "mem-md-"));
    const path = join(mdDir, "CLAUDE.md");
    writeFileSync(path, "# Conventions\n\n- Always run the linter before pushing\n- Never commit generated files\n", "utf8");
    return path;
  }

  afterEach(() => {
    if (mdDir !== undefined) {
      rmSync(mdDir, { recursive: true, force: true });
    }
  });

  it("stamps imported facts with the supplied timestamp instead of now", async () => {
    // A CLAUDE.md's rules are usually older than the store reading them. captured_at drives time-decay and contradiction precedence, so importing them as "today" states the opposite.
    const result = await runCli(["import", "--from-md", writeMarkdown(), "--root", ".", "--captured-at", "2023-04-05T06:07:08Z"]);
    expect(result.exitCode ?? 0).toBe(0);

    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as {
      facts: { captured_at: string }[];
    };
    expect(listed.facts.length).toBeGreaterThan(0);
    for (const fact of listed.facts) {
      expect(fact.captured_at).toBe("2023-04-05T06:07:08.000Z");
    }
  });

  it("defaults to now when the flag is absent", async () => {
    const before = Date.now();
    await runCli(["import", "--from-md", writeMarkdown(), "--root", "."]);
    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as {
      facts: { captured_at: string }[];
    };
    const stamped = new Date(listed.facts[0]?.captured_at ?? 0).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });

  it("normalizes a date-only value to the canonical ISO form captured_at is compared in", async () => {
    // captured_at is documented as lexically comparable because of its fixed format; accepting a legal-but-differently-spelled timestamp verbatim would quietly break that ordering.
    await runCli(["import", "--from-md", writeMarkdown(), "--root", ".", "--captured-at", "2023-04-05"]);
    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as {
      facts: { captured_at: string }[];
    };
    expect(listed.facts[0]?.captured_at).toMatch(/^2023-04-05T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it("refuses a lenient-only timestamp such as \"Release 3\" instead of back-dating the fact", async () => {
    const result = await runCli(["import", "--from-md", writeMarkdown(), "--root", ".", "--captured-at", "Release 3"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("capturedAt");
  });

  it("refuses an unparseable timestamp rather than silently falling back to now", async () => {
    // A malformed flag is a usage error, so it must fail once with a nonzero exit -- not once per candidate with exit 0, which a script reading $? would take for a successful import.
    const result = await runCli(["import", "--from-md", writeMarkdown(), "--root", ".", "--captured-at", "last tuesday"]);
    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as { facts: unknown[] };
    expect(listed.facts).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("capturedAt");
    expect(output.match(/^mem: /gmu)).toHaveLength(1);
  });

  it("refuses a future timestamp, which would outrank every real fact", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = await runCli(["import", "--from-md", writeMarkdown(), "--root", ".", "--captured-at", future]);
    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as { facts: unknown[] };
    expect(listed.facts).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("future");
    expect(output.match(/^mem: /gmu)).toHaveLength(1);
  });
});
