/** Guard that ARCHITECTURE.md's generated component table is in sync with `src/`, by calling `runSync` and `selfTest` from `scripts/sync-arch-docs.mjs` in-process -- the same engine `npm run arch:check` and `npm run arch:write` invoke, with no node spawn and so no per-test timeout override. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runSync, selfTest } from "../../scripts/sync-arch-docs.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The sync engine's self-test deletes every GIT_* variable so its temp repositories stay hermetic under a git hook; this restores them afterwards so the worker's environment is left as it was. */
function withGitEnvRestored<T>(run: () => T): T {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")));
  try {
    return run();
  } finally {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("GIT_")) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, saved);
  }
}

describe("architecture doc stays in sync with src/", () => {
  it("ARCHITECTURE.md's generated table matches the current src/ tree", () => {
    const result = runSync(REPO_ROOT, { mode: "check", format: "text", strictCurated: false });
    expect(
      result.exitCode,
      `Architecture doc drift. Run 'npm run arch:write'.\n${result.stderr.join("\n")}`,
    ).toBe(0);
  });

  it("the sync engine's own self-test passes", () => {
    const result = withGitEnvRestored(() => selfTest());
    expect(
      result.pass,
      `Architecture doc sync engine self-test failed.\n${result.summary}`,
    ).toBe(true);
  });
});
