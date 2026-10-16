import { execSync } from "child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { BUNDLE_PATH, DIGEST_PATH, FORCE_BUILD_ENV, computeBuildDigest, decideBuild, readStampedDigest } from "./bundleFreshness.js";

export async function setup(): Promise<void> {
  const root = process.cwd();
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
  const tempBundle = `${BUNDLE_PATH}.${process.pid}.tmp`;
  const tempStamp = `${DIGEST_PATH}.${process.pid}.tmp`;
  try {
    execSync(`npm run build -- --outfile ${tempBundle}`, { stdio: "inherit" });
    // Another process may have built and stamped these same inputs while this build ran; its bundle is already in place, so drop this one.
    if (!forceBuild && existsSync(join(root, BUNDLE_PATH)) && readStampedDigest(root) === digest) {
      console.warn(`Discarded build of ${BUNDLE_PATH}: another process already built these inputs`);
      return;
    }
    renameSync(join(root, tempBundle), join(root, BUNDLE_PATH));
    writeFileSync(join(root, tempStamp), digest);
    renameSync(join(root, tempStamp), join(root, DIGEST_PATH));
  } catch (error) {
    console.error("Failed to build bundle:", error);
    throw error;
  } finally {
    rmSync(join(root, tempBundle), { force: true });
    rmSync(join(root, tempStamp), { force: true });
  }
  console.warn(`Built ${BUNDLE_PATH}: ${decision.reason}`);
}
