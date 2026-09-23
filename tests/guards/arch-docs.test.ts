/**
 * Guard that ARCHITECTURE.md's generated component table is in sync with `src/`, by actually
 * running `scripts/sync-arch-docs.mjs` -- the same engine `npm run arch:check` and `npm run
 * arch:write` invoke.
 *
 * Unlike this tier's other members, this guard shells out to a subprocess rather than doing pure
 * in-process introspection. That is a deliberate exception, not an accident: the sync engine's own
 * contract (marker validation, curated-Role preservation, byte-for-byte determinism) is exactly the
 * kind of thing that is only meaningfully exercised by actually running it, and the existing guards
 * already do real file I/O of comparable cost (`docs-claims.test.ts` reads nine docs,
 * `unfed-sources.test.ts` reads five source files) -- one `git ls-files` plus one node spawn is not a
 * meaningfully heavier gate than that.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "sync-arch-docs.mjs");

function runScript(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("architecture doc stays in sync with src/", () => {
  it("ARCHITECTURE.md's generated table matches the current src/ tree", () => {
    const result = runScript(["--check"]);
    expect(
      result.status,
      `Architecture doc drift. Run 'npm run arch:write'.\n${result.stderr}`,
    ).toBe(0);
  });

  it("the sync engine's own self-test passes", () => {
    const result = runScript(["--self-test"]);
    expect(
      result.status,
      `Architecture doc sync engine self-test failed.\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
  }, 60_000);
});
