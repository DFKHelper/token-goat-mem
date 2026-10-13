/** Guard that tests/support/spawnTimeoutFloor.ts never reaches src/ and that its mirrored probe-helper argv index still equals the source constant. The module is loaded from inside a `vi.mock("node:child_process")` factory; a static import from src/ that itself imports `node:child_process` (src/probeSpawn.ts does) waits on the mock whose factory is waiting on that import, so vitest collection stalls at 0 CPU with no error. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROBE_HELPER_BUDGET_ARG_INDEX } from "../../src/probeSpawn.js";

const SUPPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "support");

/** Module specifiers the file pulls in, by static `import ... from` or by `import("...")`. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) {
    found.push(match[1] ?? "");
  }
  return found;
}

describe("regression: the spawn timeout floor stays a leaf of the node:child_process mock", () => {
  it("imports nothing from src/ (a cycle through the mocked module hangs collection)", () => {
    const floor = readFileSync(join(SUPPORT_DIR, "spawnTimeoutFloor.ts"), "utf8");
    expect(importSpecifiers(floor).filter((spec) => spec.includes("src/"))).toEqual([]);
  });

  it("mirrors the probe helper's budget argv index", () => {
    const floor = readFileSync(join(SUPPORT_DIR, "spawnTimeoutFloor.ts"), "utf8");
    const mirrored = /const PROBE_HELPER_BUDGET_ARG_INDEX = (\d+);/.exec(floor)?.[1];
    expect(Number(mirrored)).toBe(PROBE_HELPER_BUDGET_ARG_INDEX);
  });

  it("detects a src import in either import form", () => {
    expect(importSpecifiers('import { x } from "../../src/probeSpawn.js";')).toEqual(["../../src/probeSpawn.js"]);
    expect(importSpecifiers('const m = await import("../../src/probeSpawn.js");')).toEqual(["../../src/probeSpawn.js"]);
    expect(importSpecifiers('import "node:child_process";')).toEqual(["node:child_process"]);
  });
});
