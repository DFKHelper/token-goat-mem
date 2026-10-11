/** Wraps `node:child_process` so no `spawnSync` call runs under a timeout shorter than `SPAWN_TIMEOUT_FLOOR_MS`, for tests that drive src code with a hard-coded short probe timeout (wiring.ts's 4000 ms `mem --version`/`--help` probes). Process launches on a scanned Windows machine take 1-10 s each (cmd.exe then node for a `.cmd` shim), so the production budget turns a healthy fake `mem` into a timed-out, "incapable" one at random; the tests assert capability logic, not launch latency, so they get a floor the machine cannot miss. Only timeouts are raised -- argv, env, and output are untouched. */
export const SPAWN_TIMEOUT_FLOOR_MS = 120_000;

type SpawnSyncFn = (...args: unknown[]) => unknown;

/** Returns the module with `spawnSync` replaced by a pass-through that lifts any positive `timeout` option below the floor up to it. */
export function withSpawnTimeoutFloor<T extends { spawnSync: unknown }>(actual: T): T {
  const original = actual.spawnSync as SpawnSyncFn;
  const wrapped: SpawnSyncFn = (...args) => {
    const last = args.length - 1;
    const options = args[last];
    if (last >= 1 && typeof options === "object" && options !== null && !Array.isArray(options)) {
      const timeout = (options as { timeout?: unknown }).timeout;
      if (typeof timeout === "number" && timeout > 0 && timeout < SPAWN_TIMEOUT_FLOOR_MS) {
        args[last] = { ...options, timeout: SPAWN_TIMEOUT_FLOOR_MS };
      }
    }
    return original(...args);
  };
  return { ...actual, spawnSync: wrapped };
}
