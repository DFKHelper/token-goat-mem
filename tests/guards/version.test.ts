/**
 * Guard test to ensure package.json version matches CHANGELOG.md.
 * CHANGELOG.md is the canonical source of truth per its own declaration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dirname, "../..");

describe("version consistency guards", () => {
  it("package.json version matches the first [x.y.z] heading in CHANGELOG.md", () => {
    // Read package.json version
    const packageJsonPath = join(REPO_ROOT, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    const packageVersion = packageJson.version;

    expect(packageVersion, "package.json must have a version field").toBeDefined();

    // Read CHANGELOG.md and extract the first version heading
    const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
    const changelogContent = readFileSync(changelogPath, "utf8");

    // Match the first ## [x.y.z] heading, skipping non-semver headings like "## [Unreleased]" that
    // sit above the first real release while work is in progress.
    const versionMatch = changelogContent.match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m);
    const changelogVersion = versionMatch?.[1];

    expect(changelogVersion, "CHANGELOG.md must have a ## [x.y.z] version heading").toBeDefined();

    // They must match
    expect(packageVersion, `package.json version ${packageVersion} does not match CHANGELOG.md version ${changelogVersion}`).toBe(
      changelogVersion
    );
  });
});
