/** Source-level guard that `.gitleaks.toml` never suppresses a path that ships, and that the pre-commit hook and CI both run the scan. Widening an allowlist makes a secrets scan quieter, so the scan going green is exactly what the mistake looks like, and nothing else would notice `'''^src/'''` appear. Gitleaks tests an allowlist entry with an unanchored regex search, which is why every entry is also checked against real shipped paths rather than compared to a name. A config nothing runs suppresses nothing, so the hook and the CI job are pinned here too. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Allowlist {
  readonly paths: readonly string[];
  readonly targetRules: readonly string[];
  readonly hasRegexes: boolean;
}

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), "utf8");
}

/** Drops whole-line `#` comments so a quoted pattern in prose cannot be mistaken for config. */
function withoutComments(toml: string): string {
  return toml
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Every `'''literal'''` string in a TOML array value, so no TOML parser dependency is needed for the two array shapes this file uses. */
function literals(block: string, key: string): string[] {
  const array = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "mu").exec(block);
  if (array === null) {return [];}
  const quoted = [...(array[1] ?? "").matchAll(/'''(.*?)'''|"(.*?)"/gu)];
  return quoted.map((match) => match[1] ?? match[2] ?? "");
}

function allowlists(): Allowlist[] {
  const [, ...blocks] = withoutComments(readRepoFile(".gitleaks.toml")).split("[[allowlists]]");
  return blocks.map((block) => ({
    paths: literals(block, "paths"),
    targetRules: literals(block, "targetRules"),
    hasRegexes: /^regexes\s*=/mu.test(block),
  }));
}

function trackedFiles(...pathspec: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspec], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\0").filter((name) => name.length > 0);
}

/** `files` in package.json minus `dist/`, which is untracked build output and is allowlisted on purpose. */
function shippedPathspecs(): string[] {
  const manifest = JSON.parse(readRepoFile("package.json")) as { files: string[] };
  return ["src", "scripts", ...manifest.files.filter((entry) => entry !== "dist/")];
}

function matching(patterns: readonly string[], file: string): string | undefined {
  return patterns.find((pattern) => new RegExp(pattern, "u").test(file));
}

describe("gitleaks allowlist scope", () => {
  it("reads at least the fixture allowlist, so the checks below cannot pass over an empty parse", () => {
    const all = allowlists();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.flatMap((entry) => entry.paths)).toContain("^tests/");
  });

  it("matches no tracked file that ships, under any entry or rule", () => {
    const patterns = allowlists().flatMap((entry) => entry.paths);
    const shipped = trackedFiles(...shippedPathspecs());
    expect(shipped.length).toBeGreaterThan(0);
    const suppressed = shipped.flatMap((file) => {
      const pattern = matching(patterns, file);
      return pattern === undefined ? [] : [`${file} (suppressed by ${pattern})`];
    });
    expect(
      suppressed,
      "the .gitleaks.toml allowlist covers a shipped path, so a credential committed there would not fail the scan; narrow the entry rather than this test",
    ).toEqual([]);
  });

  it("matches a path that does not exist yet under src/ or scripts/, so a new shipped file is covered too", () => {
    const patterns = allowlists().flatMap((entry) => entry.paths);
    for (const probe of ["src/new-module.ts", "src/nested/deep/file.ts", "scripts/new-script.mjs", "scripts/postinstall.mjs"]) {
      expect(matching(patterns, probe), probe).toBeUndefined();
    }
  });

  it("gives every entry a path, because an entry with only a regex applies to the whole tree", () => {
    for (const entry of allowlists()) {
      expect(entry.paths.length).toBeGreaterThan(0);
    }
  });

  it("keeps any entry that is not about fixtures narrowed to named rules", () => {
    const fixtureOnly = new Set(["^tests/", "^node_modules/", "^dist/", "^coverage/", String.raw`^\.claude/worktrees/`]);
    for (const entry of allowlists()) {
      if (entry.paths.every((pattern) => fixtureOnly.has(pattern))) {continue;}
      expect(entry.targetRules.length, `entry for ${entry.paths.join(", ")} must name its rules`).toBeGreaterThan(0);
      expect(entry.hasRegexes, `entry for ${entry.paths.join(", ")} must pin the value it allows`).toBe(true);
    }
  });

  it("holds no tracked file under the build, dependency and worktree prefixes it skips", () => {
    expect(trackedFiles("dist", "node_modules", "coverage", ".claude/worktrees")).toEqual([]);
  });

  it("keeps the default rule pack, so the allowlists narrow a real ruleset rather than an empty one", () => {
    expect(/^\[extend\][^[]*^useDefault\s*=\s*true/mu.test(withoutComments(readRepoFile(".gitleaks.toml")))).toBe(true);
  });
});

describe("gitleaks is executed", () => {
  const SCAN_FLAGS = [/--config=\.gitleaks\.toml/u, /--exit-code 1/u];

  it("by the pre-commit hook, which refuses to commit when the binary is missing", () => {
    const hook = readRepoFile(".githooks", "pre-commit");
    expect(hook).toContain("gitleaks dir .");
    for (const flag of SCAN_FLAGS) {expect(hook).toMatch(flag);}
    const missing = hook.indexOf("command -v gitleaks");
    expect(missing).toBeGreaterThan(-1);
    expect(hook.indexOf("exit 1", missing)).toBeGreaterThan(missing);
    expect(hook.indexOf("gitleaks dir .")).toBeLessThan(hook.indexOf("npm run lint"));
  });

  it("by CI on a checksum-verified pinned binary, with a read-only token", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml");
    expect(workflow).toContain("gitleaks dir .");
    for (const flag of SCAN_FLAGS) {expect(workflow).toMatch(flag);}
    expect(workflow).toMatch(/GITLEAKS_VERSION: "\d+\.\d+\.\d+"/u);
    expect(workflow).toMatch(/GITLEAKS_SHA256: "[0-9a-f]{64}"/u);
    expect(workflow).toContain("sha256sum -c");
    expect(workflow).toMatch(/secrets:[\s\S]*?permissions:\s*\n\s*contents: read/u);
  });
});
