import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The bundle esbuild writes, relative to the repository root. */
export const BUNDLE_PATH = "dist/token-goat-mem.mjs";

/** The digest of the inputs the current bundle was built from, written only after a successful build. */
export const DIGEST_PATH = "dist/.build-inputs.sha256";

/** Single files outside src/ that esbuild reads to produce the bundle (tsconfig.json is read for compiler options). */
const BUILD_INPUT_FILES = ["package.json", "package-lock.json", "esbuild.config.mjs", "tsconfig.json"];

/** Environment variable that forces a rebuild even when the digest matches. */
export const FORCE_BUILD_ENV = "TOKEN_GOAT_MEM_FORCE_BUILD";

export interface BuildDecisionInput {
  bundleExists: boolean;
  stampedDigest: string | null;
  currentDigest: string;
  forceBuild: boolean;
}

export interface BuildDecision {
  build: boolean;
  reason: string;
}

function listFilesSorted(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {found.push(...listFilesSorted(join(dir, entry.name), rel));}
    else if (entry.isFile()) {found.push(rel);}
  }
  return found.sort();
}

function addEntry(hash: ReturnType<typeof createHash>, label: string, content: Buffer): void {
  // Length-prefix both parts so no path and content pair can collide with a different split of the same bytes.
  hash.update(`${Buffer.byteLength(label)}:${label}\n${content.length}:`);
  hash.update(content);
  hash.update("\n");
}

/** Digest of everything the bundle is built from: every src/ file's path and content, the build config files, and NODE_ENV (unset distinct from empty). Content only, never mtime. */
export function computeBuildDigest(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256");
  for (const rel of listFilesSorted(join(root, "src"), "src")) {
    addEntry(hash, rel, readFileSync(join(root, rel)));
  }
  for (const rel of BUILD_INPUT_FILES) {
    const abs = join(root, rel);
    addEntry(hash, rel, existsSync(abs) ? readFileSync(abs) : Buffer.from("<absent>"));
  }
  const nodeEnv = env["NODE_ENV"];
  addEntry(hash, "NODE_ENV", Buffer.from(nodeEnv === undefined ? "unset" : `set:${nodeEnv}`));
  return hash.digest("hex");
}

/** Skip the build only when the bundle exists, the stamp equals the current digest, and a rebuild was not forced. */
export function decideBuild(input: BuildDecisionInput): BuildDecision {
  if (input.forceBuild) {return { build: true, reason: `${FORCE_BUILD_ENV}=1` };}
  if (!input.bundleExists) {return { build: true, reason: `${BUNDLE_PATH} is missing` };}
  if (input.stampedDigest === null) {return { build: true, reason: "no build-inputs digest recorded" };}
  if (input.stampedDigest !== input.currentDigest) {return { build: true, reason: "build inputs changed" };}
  return { build: false, reason: "build inputs unchanged" };
}

/** Reads the recorded digest, or null when none was written. */
export function readStampedDigest(root: string): string | null {
  const abs = join(root, DIGEST_PATH);
  return existsSync(abs) ? readFileSync(abs, "utf8").trim() : null;
}
