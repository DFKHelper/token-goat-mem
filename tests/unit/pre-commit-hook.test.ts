/** Runs the real pre-commit hook with gitleaks absent from PATH and checks it refuses instead of skipping the secret scan. */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOOK = join(import.meta.dirname, "../../.githooks/pre-commit");

describe.skipIf(process.platform === "win32")("pre-commit hook without gitleaks", () => {
  it("exits 1 naming the missing scanner", () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "mem-hook-path-"));
    const cwd = mkdtempSync(join(tmpdir(), "mem-hook-cwd-"));
    try {
      // The hook reaches the gitleaks check using only shell builtins (set, unset, command -v, echo), so an empty PATH dir needs no git shim.
      const result = spawnSync("/bin/sh", [HOOK], { cwd, env: { PATH: emptyPath }, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pre-commit: gitleaks is not installed, so the secret scan cannot run.");
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
