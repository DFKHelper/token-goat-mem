/** Guard that tests/support/spawnTimeoutFloor.ts never reaches src/ and that its mirrored probe-helper argv index still equals the source constant. The module is loaded from inside a `vi.mock("node:child_process")` factory; a static import from src/ that itself imports `node:child_process` (src/probeSpawn.ts does) waits on the mock whose factory is waiting on that import, so vitest collection stalls at 0 CPU with no error. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROBE_HELPER_BUDGET_ARG_INDEX } from "../../src/probeSpawn.js";

const SUPPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "support");
const SRC_DIR = join(SUPPORT_DIR, "..", "..", "src");

/** Module specifiers the file pulls in, by static `import ... from`, a re-export `export ... from`, a bare `import "x"`, `import("...")` or `require("...")`. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) {
    found.push(match[1] ?? "");
  }
  return found;
}

/** The on-disk file a relative specifier names from `fromFile` (a `.js` specifier maps to its `.ts` source), or null for a bare or built-in specifier. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const target = resolve(dirname(fromFile), specifier);
  const candidates = [target, target.replace(/\.js$/u, ".ts"), `${target}.ts`, join(target, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? target;
}

/** Every file reachable from `entry` through relative imports, `entry` included, so a hop through another support file is followed. */
function relativeClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!file.endsWith(".ts") || !existsSync(file)) {
      continue;
    }
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const next = resolveRelative(file, specifier);
      if (next !== null) {
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** Whether `file` sits inside the repo's src/ directory. */
function isInsideSrc(file: string): boolean {
  const rel = relative(SRC_DIR, file);
  return rel !== "" && !rel.startsWith("..");
}

describe("regression: the spawn timeout floor stays a leaf of the node:child_process mock", () => {
  it("reaches nothing in src/ by any specifier shape or hop through another support file (a cycle through the mocked module hangs collection)", () => {
    const reached = relativeClosure(join(SUPPORT_DIR, "spawnTimeoutFloor.ts"));
    expect(reached.filter(isInsideSrc)).toEqual([]);
  });

  it("keeps spawnTimeoutFloorMs.ts import-free: no import, re-export, dynamic import or require of any kind", () => {
    const leaf = readFileSync(join(SUPPORT_DIR, "spawnTimeoutFloorMs.ts"), "utf8");
    expect(importSpecifiers(leaf)).toEqual([]);
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
    expect(importSpecifiers('export * from "../support/cli.js";')).toEqual(["../support/cli.js"]);
    expect(importSpecifiers('export { x } from "./other.js";')).toEqual(["./other.js"]);
    expect(importSpecifiers('import {\n  a,\n  b,\n} from "../../src/x.js";')).toEqual(["../../src/x.js"]);
    expect(importSpecifiers('const m = require("../../src/x.js");')).toEqual(["../../src/x.js"]);
  });

  it("resolves a relative specifier to src/ whatever its shape", () => {
    const fromSupport = join(SUPPORT_DIR, "spawnTimeoutFloor.ts");
    expect(isInsideSrc(resolveRelative(fromSupport, "../../src/probeSpawn.js") ?? "")).toBe(true);
    expect(isInsideSrc(resolveRelative(fromSupport, "../../src/./nested/../probeSpawn") ?? "")).toBe(true);
    expect(isInsideSrc(resolveRelative(fromSupport, "./spawnTimeoutFloorMs.js") ?? "")).toBe(false);
    expect(resolveRelative(fromSupport, "node:child_process")).toBeNull();
  });
});
