import { execSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { BUNDLE_PATH, DIGEST_PATH, FORCE_BUILD_ENV, computeBuildDigest, decideBuild, readStampedDigest } from "./bundleFreshness.js";

export async function setup(): Promise<void> {
  const root = process.cwd();
  // Digest before the build, so an edit made while it runs is never stamped as built.
  const digest = computeBuildDigest(root);
  const decision = decideBuild({
    bundleExists: existsSync(join(root, BUNDLE_PATH)),
    stampedDigest: readStampedDigest(root),
    currentDigest: digest,
    forceBuild: process.env[FORCE_BUILD_ENV] === "1",
  });
  if (!decision.build) {
    console.warn(`Skipped build of ${BUNDLE_PATH}: ${decision.reason}`);
    return;
  }
  try {
    execSync("npm run build", { stdio: "inherit" });
  } catch (error) {
    console.error("Failed to build bundle:", error);
    throw error;
  }
  writeFileSync(join(root, DIGEST_PATH), digest);
  console.warn(`Built ${BUNDLE_PATH}: ${decision.reason}`);
}
