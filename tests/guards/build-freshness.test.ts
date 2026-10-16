/** Guard for the globalSetup build skip: the digest tracks build inputs by content, and the skip decision never ships a missing or stale bundle. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_PATH, DIGEST_PATH, computeBuildDigest, decideBuild } from "../setup/bundleFreshness.js";
import { type BundleInstall, installBuiltBundle, removeStaleTempFiles } from "../setup/build-bundle.js";

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

describe("installing a finished build", () => {
  const eperm = (): never => {
    throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  };
  let install: BundleInstall;

  beforeEach(() => {
    mkdirSync(join(root, "dist"));
    install = { root, digest: "ours", forceBuild: false, tempBundle: `${BUNDLE_PATH}.4242.tmp`, tempStamp: `${DIGEST_PATH}.4242.tmp` };
    writeFileSync(join(root, install.tempBundle), "new bundle");
    writeFileSync(join(root, BUNDLE_PATH), "old bundle");
    writeFileSync(join(root, DIGEST_PATH), "other\n");
  });

  it("renames the build and its stamp into place", () => {
    expect(installBuiltBundle(install)).toBe("installed");
    expect(readFileSync(join(root, BUNDLE_PATH), "utf8")).toBe("new bundle");
    expect(readFileSync(join(root, DIGEST_PATH), "utf8")).toBe("ours");
    expect(existsSync(join(root, install.tempStamp))).toBe(false);
  });

  it("discards its build when the identical build is already stamped before the rename", () => {
    writeFileSync(join(root, DIGEST_PATH), "ours\n");
    expect(installBuiltBundle(install, eperm)).toBe("discarded");
    expect(readFileSync(join(root, BUNDLE_PATH), "utf8")).toBe("old bundle");
  });

  it("discards its build when an EPERM rename finds the identical build stamped meanwhile", () => {
    const stampThenRefuse = (): never => {
      writeFileSync(join(root, DIGEST_PATH), "ours\n");
      return eperm();
    };
    expect(installBuiltBundle(install, stampThenRefuse)).toBe("discarded");
    expect(readFileSync(join(root, BUNDLE_PATH), "utf8")).toBe("old bundle");
  });

  it("discards its build when an EPERM rename finds the installed bundle identical but not yet stamped", () => {
    writeFileSync(join(root, BUNDLE_PATH), "new bundle");
    expect(installBuiltBundle(install, eperm)).toBe("discarded");
    expect(installBuiltBundle({ ...install, forceBuild: true }, eperm)).toBe("discarded");
  });

  it("names the cause and keeps the bundle when an EPERM rename finds different inputs stamped", () => {
    let thrown: unknown;
    try {
      installBuiltBundle(install, eperm);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/another process holds it open while testing different build inputs/u);
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(readFileSync(join(root, BUNDLE_PATH), "utf8")).toBe("old bundle");
  });

  it("never discards a forced build on an EPERM rename, even with a matching stamp", () => {
    writeFileSync(join(root, DIGEST_PATH), "ours\n");
    expect(() => installBuiltBundle({ ...install, forceBuild: true }, eperm)).toThrow(/different build inputs \(or a forced build\)/u);
  });

  it("rethrows any other rename error unchanged", () => {
    const enospc = (): never => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };
    expect(() => installBuiltBundle(install, enospc)).toThrow("ENOSPC");
  });

  it("removes temp files of dead pids and keeps those of live pids and unrelated files", () => {
    const names = ["token-goat-mem.mjs.111.tmp", ".build-inputs.sha256.111.tmp", "token-goat-mem.mjs.222.tmp", ".build-inputs.sha256.222.tmp", "other.222.tmp"];
    for (const name of names) {writeFileSync(join(root, "dist", name), "x");}
    removeStaleTempFiles(root, (pid) => pid === 222);
    const left = names.filter((name) => existsSync(join(root, "dist", name)));
    expect(left).toEqual(["token-goat-mem.mjs.222.tmp", ".build-inputs.sha256.222.tmp", "other.222.tmp"]);
  });
});
