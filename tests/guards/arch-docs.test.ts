/** Guard that ARCHITECTURE.md's generated component table is in sync with `src/`, by calling `runSync` and `selfTest` from `scripts/sync-arch-docs.mjs` in-process -- the same engine `npm run arch:check` and `npm run arch:write` invoke, with no node spawn and so no per-test timeout override. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSync, selfTest } from "../../scripts/sync-arch-docs.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("architecture doc stays in sync with src/", () => {
  it("ARCHITECTURE.md's generated table matches the current src/ tree", () => {
    const result = runSync(REPO_ROOT, { mode: "check", format: "text", strictCurated: false });
    expect(
      result.exitCode,
      `Architecture doc drift. Run 'npm run arch:write'.\n${result.stderr.join("\n")}`,
    ).toBe(0);
  });

  it("the sync engine's own self-test passes", () => {
    const result = selfTest();
    expect(
      result.pass,
      `Architecture doc sync engine self-test failed.\n${result.summary}`,
    ).toBe(true);
  });

  it("the sync engine's own self-test starts no process: it passes with no git reachable on PATH", () => {
    // Every process start costs seconds on a loaded host and the self-test runs inside the 30 s test bound, so a case that reaches git is a timing dependence; with nothing on PATH such a case fails here, deterministically.
    const emptyBin = mkdtempSync(join(tmpdir(), "mem-no-git-"));
    try {
      vi.stubEnv("PATH", emptyBin);
      const result = selfTest();
      expect(result.pass, `The self-test needed a process it could not start.\n${result.summary}`).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});
