/** The test-only no-fsync switch (src/db.ts's `unsafeNoFsyncEnabled`): `openDb` runs `synchronous = OFF` only for the exact value `1` together with an explicit `TOKEN_GOAT_MEM_HOME`, and leaves the default (1, NORMAL, as better-sqlite3 builds SQLite for WAL) in every other case. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../../src/db.js";

const SWITCH = "TOKEN_GOAT_MEM_TEST_UNSAFE_NO_FSYNC";
const HOME = "TOKEN_GOAT_MEM_HOME";
const SYNCHRONOUS_OFF = 0;
const SYNCHRONOUS_DEFAULT = 1;

let workDir: string;
const prior = new Map<string, string | undefined>();

/** Sets a variable, or removes it for `undefined`, remembering its value so afterEach puts it back. */
function setEnv(name: string, value: string | undefined): void {
  if (!prior.has(name)) {
    prior.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** The `synchronous` level of a store `openDb` just opened. */
function synchronousOf(): number {
  const db = openDb(join(workDir, "mem.db"), { autoSnapshot: false });
  try {
    return db.pragma("synchronous", { simple: true }) as number;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mem-no-fsync-"));
});

afterEach(() => {
  for (const [name, value] of prior) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  prior.clear();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the test-only no-fsync switch", () => {
  it("turns synchronous off for the value 1 with an explicit home", () => {
    setEnv(HOME, workDir);
    setEnv(SWITCH, "1");

    expect(synchronousOf()).toBe(SYNCHRONOUS_OFF);
  });

  it("keeps the default when the switch is unset", () => {
    setEnv(HOME, workDir);
    setEnv(SWITCH, undefined);

    expect(synchronousOf()).toBe(SYNCHRONOUS_DEFAULT);
  });

  it.each(["0", "true", "yes", "11", " 1", "1 ", ""])("keeps the default for the value %j", (value) => {
    setEnv(HOME, workDir);
    setEnv(SWITCH, value);

    expect(synchronousOf()).toBe(SYNCHRONOUS_DEFAULT);
  });

  it("keeps the default without an explicit home, whatever the switch says", () => {
    setEnv(HOME, undefined);
    setEnv(SWITCH, "1");

    expect(synchronousOf()).toBe(SYNCHRONOUS_DEFAULT);
  });

  it("keeps the default when the home is set to an empty string", () => {
    setEnv(HOME, "");
    setEnv(SWITCH, "1");

    expect(synchronousOf()).toBe(SYNCHRONOUS_DEFAULT);
  });
});
