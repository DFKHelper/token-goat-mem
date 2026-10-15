import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { wiringHomeFromEnv } from "../../src/doctorWiring.js";
import { PINNED_ENV, SCRUBBED_ENV } from "../setup/isolated-env.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Every `TOKEN_GOAT_MEM_*` name `src/` holds as a whole string literal. A read is either `process.env["NAME"]` or `export const X_ENV = "NAME"` read later through `env[X_ENV]`, so the quoted name is the one place both forms agree; a name that only appears inside a longer message or comment is not a read. */
function envNamesReadBySrc(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(SRC_DIR)) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'`](TOKEN_GOAT_MEM_[A-Z0-9_]+)["'`]/gu)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

describe("shared test setup isolates every TOKEN_GOAT_MEM_* variable src reads", () => {
  it("scrubs or pins each name src reads, so an exported variable cannot change an in-process run", () => {
    const read = envNamesReadBySrc();
    const handled = new Set<string>([...PINNED_ENV, ...SCRUBBED_ENV]);

    expect(read, "the scan found no variable names in src/, so it is looking in the wrong place").toContain("TOKEN_GOAT_MEM_HOME");
    const unhandled = read.filter((name) => !handled.has(name));
    expect(unhandled, `src reads these but tests/setup/isolated-env.ts neither scrubs nor pins them: ${unhandled.join(", ")}`).toEqual([]);
  });

  it("keeps the pinned and scrubbed lists disjoint", () => {
    const overlap = SCRUBBED_ENV.filter((name) => (PINNED_ENV as readonly string[]).includes(name));

    expect(overlap, `a name in both lists is deleted and pinned at once: ${overlap.join(", ")}`).toEqual([]);
  });

  it("leaves each scrubbed variable unset and each pinned variable set while a test runs", () => {
    const stillSet = SCRUBBED_ENV.filter((name) => process.env[name] !== undefined);
    const unpinned = PINNED_ENV.filter((name) => (process.env[name] ?? "") === "");

    expect(stillSet, `tests/setup/isolate-home.ts did not delete: ${stillSet.join(", ")}`).toEqual([]);
    expect(unpinned, `tests/setup/isolate-home.ts did not set: ${unpinned.join(", ")}`).toEqual([]);
  });

  it("resolves the wiring home to a temp directory for a test that does not set it, never the real home", () => {
    const wiringHome = wiringHomeFromEnv();

    expect(wiringHome, "the wiring home is unset, so doctor would read the real home directory").toBeDefined();
    const fromTmp = relative(tmpdir(), wiringHome as string);
    expect(fromTmp.startsWith("..") || isAbsolute(fromTmp), `${wiringHome} is not under ${tmpdir()}`).toBe(false);
    expect(wiringHome, "the wiring home is the real home directory").not.toBe(homedir());
  });
});
