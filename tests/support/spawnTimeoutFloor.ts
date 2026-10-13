import { SPAWN_TIMEOUT_FLOOR_MS } from "./spawnTimeoutFloorMs.js";

export { SPAWN_TIMEOUT_FLOOR_MS };

// Mirrors PROBE_HELPER_BUDGET_ARG_INDEX in src/probeSpawn.ts; importing that module here would close a cycle through the mocked node:child_process and hang collection, so tests/guards/spawn-floor-leaf.test.ts pins the two equal.
const PROBE_HELPER_BUDGET_ARG_INDEX = 2;

type SpawnSyncFn = (...args: unknown[]) => unknown;

/** Returns the module with `spawnSync` replaced by a pass-through that lifts any positive `timeout` option below the floor up to it. */
export function withSpawnTimeoutFloor<T extends { spawnSync: unknown }>(actual: T): T {
  const original = actual.spawnSync as SpawnSyncFn;
  const wrapped: SpawnSyncFn = (...args) => {
    const last = args.length - 1;
    const options = args[last];
    const helperArgs = args[1];
    if (last >= 2 && Array.isArray(helperArgs) && helperArgs[0] === "-e") {
      const budget = Number(helperArgs[PROBE_HELPER_BUDGET_ARG_INDEX]);
      if (budget > 0 && budget < SPAWN_TIMEOUT_FLOOR_MS) {
        args[1] = helperArgs.map((arg, index) => (index === PROBE_HELPER_BUDGET_ARG_INDEX ? String(SPAWN_TIMEOUT_FLOOR_MS) : arg));
      }
    }
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
