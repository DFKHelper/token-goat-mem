/** Guard for the globalSetup build skip: the digest tracks build inputs by content, and the skip decision never ships a missing or stale bundle. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBuildDigest, decideBuild } from "../setup/bundleFreshness.js";

let root: string;
const NO_ENV: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-freshness-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "nested", "util.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.0.0"}\n');
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "esbuild.config.mjs"), "export default {};\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("build input digest", () => {
  it("is stable for identical inputs", () => {
    expect(computeBuildDigest(root, NO_ENV)).toBe(computeBuildDigest(root, NO_ENV));
  });

  it("changes when one src file's content changes", () => {
    const before = computeBuildDigest(root, NO_ENV);
    writeFileSync(join(root, "src", "nested", "util.ts"), "export const b = 3;\n");
    expect(computeBuildDigest(root, NO_ENV)).not.toBe(before);
  });

  it("changes when a new untracked src file is added", () => {
    const before = computeBuildDigest(root, NO_ENV);
    writeFileSync(join(root, "src", "added.ts"), "export const c = 3;\n");
    expect(computeBuildDigest(root, NO_ENV)).not.toBe(before);
  });

  it("changes when a build config file changes", () => {
    const before = computeBuildDigest(root, NO_ENV);
    writeFileSync(join(root, "esbuild.config.mjs"), "export default { bundle: true };\n");
    expect(computeBuildDigest(root, NO_ENV)).not.toBe(before);
  });

  it("changes when NODE_ENV changes, and unset differs from empty", () => {
    const unset = computeBuildDigest(root, NO_ENV);
    const empty = computeBuildDigest(root, { NODE_ENV: "" });
    const dev = computeBuildDigest(root, { NODE_ENV: "development" });
    expect(new Set([unset, empty, dev]).size).toBe(3);
  });

  it("does not change on an mtime-only touch", () => {
    const before = computeBuildDigest(root, NO_ENV);
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(root, "src", "main.ts"), future, future);
    utimesSync(join(root, "package.json"), future, future);
    expect(computeBuildDigest(root, NO_ENV)).toBe(before);
  });
});

describe("build skip decision", () => {
  const matching = { bundleExists: true, stampedDigest: "abc", currentDigest: "abc", forceBuild: false };

  it("skips only when the bundle exists, the digest matches and no rebuild is forced", () => {
    expect(decideBuild(matching).build).toBe(false);
  });

  it("builds when the bundle is missing, even with a matching digest file", () => {
    expect(decideBuild({ ...matching, bundleExists: false }).build).toBe(true);
  });

  it("builds when the digest file is missing", () => {
    expect(decideBuild({ ...matching, stampedDigest: null }).build).toBe(true);
  });

  it("builds when the digest file differs", () => {
    expect(decideBuild({ ...matching, stampedDigest: "old" }).build).toBe(true);
  });

  it("builds when a rebuild is forced", () => {
    expect(decideBuild({ ...matching, forceBuild: true }).build).toBe(true);
  });
});
