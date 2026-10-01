/** Guard that every comment in the tracked sources stays on one line and no doc comment is left stranded on another, by running `scripts/single-line-comments.mjs` -- the engine `npm run comments:check` and `npm run comments:write` invoke. Shells out for the same reason `arch-docs.test.ts` does: the engine's contract is only meaningfully exercised by running it. */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "single-line-comments.mjs");

function runScript(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

describe("comments stay single-line", () => {
  it("no tracked source has a multi-line or stacked doc comment", () => {
    const result = runScript(["--check"]);
    expect(result.status, `Comment shape drift. Run 'npm run comments:write'.\n${result.stderr}`).toBe(0);
  }, 60_000);

  it("the comment engine's own self-test passes", () => {
    const result = runScript(["--self-test"]);
    expect(result.status, `Comment engine self-test failed.\n${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
