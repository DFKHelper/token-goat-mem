import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { BUNDLE_PATH, DIGEST_PATH, FORCE_BUILD_ENV, computeBuildDigest, decideBuild, readStampedDigest } from "./bundleFreshness.js";

/** Private build outputs are `<bundle or stamp name>.<pid>.tmp` beside the real files. */
const TEMP_FILE_NAME = /^(?:token-goat-mem\.mjs|\.build-inputs\.sha256)\.(\d+)\.tmp$/u;

export interface BundleInstall {
  root: string;
  digest: string;
  forceBuild: boolean;
  tempBundle: string;
  tempStamp: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Removes temp build files left in dist/ by a setup that died mid-build; a file named for a live pid is never touched. */
export function removeStaleTempFiles(root: string, isAlive: (pid: number) => boolean = pidIsAlive): void {
  const dir = join(root, dirname(BUNDLE_PATH));
  if (!existsSync(dir)) {return;}
  for (const name of readdirSync(dir)) {
    const pid = TEMP_FILE_NAME.exec(name)?.[1];
    if (pid !== undefined && !isAlive(Number(pid))) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

/** True when another process already installed a bundle built from these exact inputs, so ours need not replace it. */
function alreadyInstalled(install: BundleInstall): boolean {
  return !install.forceBuild && existsSync(join(install.root, BUNDLE_PATH)) && readStampedDigest(install.root) === install.digest;
}

/** True when the installed bundle is byte for byte the build in hand, so replacing it would change nothing even if its stamp is not written yet. */
function installedBundleMatches(install: BundleInstall): boolean {
  const installed = join(install.root, BUNDLE_PATH);
  return existsSync(installed) && readFileSync(installed).equals(readFileSync(join(install.root, install.tempBundle)));
}

/** Moves the finished temp build into place and stamps it; returns "discarded" when an identical build is already there. */
export function installBuiltBundle(install: BundleInstall, rename: (from: string, to: string) => void = renameSync): "installed" | "discarded" {
  const { root, digest, tempBundle, tempStamp } = install;
  if (alreadyInstalled(install)) {return "discarded";}
  try {
    rename(join(root, tempBundle), join(root, BUNDLE_PATH));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {throw error;}
    // Windows refuses to replace a file another process holds open. Decide on fresh state: that process may have installed this very build, and it may not have written its stamp yet.
    if (alreadyInstalled(install) || installedBundleMatches(install)) {return "discarded";}
    throw new Error(
      `Cannot replace ${BUNDLE_PATH}: another process holds it open while testing different build inputs (or a forced build), so the bundle cannot be replaced under it. Rerun when that run finishes.`,
      { cause: error },
    );
  }
  writeFileSync(join(root, tempStamp), digest);
  rename(join(root, tempStamp), join(root, DIGEST_PATH));
  return "installed";
}

export async function setup(): Promise<void> {
  const root = process.cwd();
  removeStaleTempFiles(root);
  // Digest before the build, so an edit made while it runs is never stamped as built.
  const digest = computeBuildDigest(root);
  const forceBuild = process.env[FORCE_BUILD_ENV] === "1";
  const decision = decideBuild({
    bundleExists: existsSync(join(root, BUNDLE_PATH)),
    stampedDigest: readStampedDigest(root),
    currentDigest: digest,
    forceBuild,
  });
  if (!decision.build) {
    console.warn(`Skipped build of ${BUNDLE_PATH}: ${decision.reason}`);
    return;
  }
  // Build and stamp under private names beside the real files, then rename over them, so another vitest process never opens a truncated or half-written bundle.
  const install: BundleInstall = {
    root,
    digest,
    forceBuild,
    tempBundle: `${BUNDLE_PATH}.${process.pid}.tmp`,
    tempStamp: `${DIGEST_PATH}.${process.pid}.tmp`,
  };
  let outcome: "installed" | "discarded";
  try {
    execSync(`npm run build -- --outfile ${install.tempBundle}`, { stdio: "inherit" });
    outcome = installBuiltBundle(install);
  } catch (error) {
    console.error("Failed to build bundle:", error);
    throw error;
  } finally {
    rmSync(join(root, install.tempBundle), { force: true });
    rmSync(join(root, install.tempStamp), { force: true });
  }
  if (outcome === "discarded") {
    console.warn(`Discarded build of ${BUNDLE_PATH}: another process already built these inputs`);
    return;
  }
  console.warn(`Built ${BUNDLE_PATH}: ${decision.reason}`);
}
