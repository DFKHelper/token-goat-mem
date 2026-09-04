/**
 * Source-level guard that every test file driving `buildHintFormat` pins the retrieval soft budget.
 *
 * `buildHintFormat` returns an *empty* hint set when it overruns its 150ms soft budget, because
 * TGMEM/2 has no way to express partialness (see RETRIEVAL_BUDGET_MS in src/integration-seam.ts).
 * That is deliberate, and it makes every content assertion against the seam implicitly an assertion
 * about how fast the runner is: on a cold Windows CI runner the budget can go on opening the
 * database alone, and every assertion in the file fails at once for a reason unrelated to what it
 * tests.
 *
 * This is not hypothetical. `tests/unit/integration-seam.test.ts` acquired a budget-pinning wrapper
 * in 0.3.0 after exactly that flake. `tests/integration-seam.test.ts` was left out of that fix, and
 * stayed green only because budget exhaustion then merely *shrank* the result -- a content assertion
 * could still pass against the smaller set. The moment exhaustion started emptying the result
 * instead, the same latent flake turned two Windows CI jobs red. A per-file convention that one
 * file can be added without is not a guarantee; this test is what makes it one.
 *
 * The seam has two doors, and the first version of this guard watched only one. A test file can
 * import `buildHintFormat` and call it, or it can run `mem recall --hint-format` through the CLI
 * (`runCli` in-process, or the built bundle in a subprocess) and reach the seam without ever naming
 * it. `tests/cli.test.ts` does the latter, was invisible to the import-keyed check, and turned the
 * 0.4.0 release gate red on Windows with the same empty `TGMEM/2` shape. For that door the pin is
 * the `TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS` environment variable, which `src/cli.ts` forwards as
 * `retrievalBudgetMs` on the `--hint-format` path only; the shared setup file sets it once for every
 * in-process file, and a subprocess-driving file inherits it by spreading `process.env` into the
 * child's environment or sets it explicitly.
 *
 * Scope, stated honestly: this asserts the *file* defines a pin, not that every call site uses it.
 * A file may legitimately call `buildHintFormat` unpinned -- the scale-invariant test does, because
 * exercising the real default budget is its entire point. On the CLI side the env-level pin counts
 * as the file's pin: it is process-wide, so a file that wants the real budget through the CLI would
 * have to delete the variable itself, and nothing in the suite does. What cannot happen after this
 * guard is a new seam test file arriving with no pin at all, through either door, which is the
 * failure that actually occurred -- twice.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests");
const SHARED_SETUP = "tests/setup/isolate-home.ts";
const VITEST_CONFIG = "vitest.config.ts";

/** Every `.ts` file under `tests/`, recursively, as repo-relative paths. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...testFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Whether `text` imports `buildHintFormat`, as opposed to merely naming it.
 *
 * Deliberately keyed on the import and not on a `buildHintFormat(` call: `tests/cli.test.ts`
 * mentions the function in a comment explaining the CLI's fail-open path, and flagging that would
 * be a false positive on a file that never drives the seam at all.
 */
function importsSeam(text: string): boolean {
  return /import\s+[^;]*\bbuildHintFormat\b[^;]*from\s+["'][^"']*integration-seam\.js["']/s.test(text);
}

/** Whether `text` defines a soft-budget pin for direct `buildHintFormat` calls. */
function pinsBudget(text: string): boolean {
  return /\bNO_TRUNCATION_BUDGET_MS\b/.test(text);
}

/** Whether `text` runs the CLI in-process by importing `run` from `src/cli.ts`. */
function importsCli(text: string): boolean {
  return /import\s+[^;]*\brun\b[^;]*from\s+["'][^"']*src\/cli\.js["']/s.test(text);
}

/** Whether `text` runs the built bundle in a subprocess. */
function spawnsBundle(text: string): boolean {
  return /token-goat-mem\.mjs/.test(text);
}

/**
 * Whether `text` reaches the seam through the CLI: it passes `--hint-format` and has a way to run
 * the CLI. Both halves are required so a file that merely quotes the flag in a comment or asserts
 * on help text is not a false positive.
 */
function drivesSeamViaCli(text: string): boolean {
  return /--hint-format/.test(text) && (importsCli(text) || spawnsBundle(text));
}

/** Whether `text` names the CLI-path pin, the environment variable `src/cli.ts` reads. */
function namesEnvPin(text: string): boolean {
  return /\bTOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS\b/.test(text);
}

/** Whether `text` hands a spawned child an explicit environment object instead of inheriting. */
function buildsChildEnv(text: string): boolean {
  return /\benv:\s*\{/.test(text);
}

/** Whether `text` passes the parent's environment on to a spawned child, pin included. */
function inheritsProcessEnv(text: string): boolean {
  return /\.\.\.process\.env\b/.test(text);
}

/**
 * Whether the shared setup file pins the budget for every in-process test, and is actually wired
 * into vitest so that pin runs. Both are checked because either one going missing silently
 * unpins every CLI-path file at once.
 */
function sharedSetupPinsBudget(): boolean {
  const setupText = readRepoFile(SHARED_SETUP);
  const configText = readRepoFile(VITEST_CONFIG);
  // Keyed on the assignment, not on the variable's name: the setup file names the variable in a
  // constant and a comment, and with only those left the pin would read as present while every
  // CLI-path file ran against the real budget.
  const declaresName = /const RETRIEVAL_BUDGET_ENV = "TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS"/.test(setupText);
  const assigns = /process\.env\[RETRIEVAL_BUDGET_ENV\] = NO_TRUNCATION_BUDGET_MS;/.test(setupText);
  return declaresName && assigns && configText.includes(SHARED_SETUP);
}

/**
 * Whether a CLI-path file is pinned. Naming the variable itself always counts. Otherwise the
 * shared setup's env pin counts, because an in-process `runCli` reads the worker's `process.env`
 * and a spawned child inherits it unless the file builds the child an explicit environment. A file
 * that does build one must spread `process.env` into it: a child given a fresh environment sees
 * the real 150ms budget no matter what the parent set.
 */
function cliPathPinned(text: string, envPinned: boolean): boolean {
  if (namesEnvPin(text)) {
    return true;
  }
  if (!envPinned) {
    return false;
  }
  if (spawnsBundle(text) && buildsChildEnv(text) && !inheritsProcessEnv(text)) {
    return false;
  }
  return true;
}

describe("integration-seam test files", () => {
  it("pin the retrieval soft budget, so a slow runner cannot empty their results", () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return importsSeam(text) && !pinsBudget(text);
      })
      .map(repoRelative);

    expect(offenders).toEqual([]);
  });

  it("is actually watching something -- at least one file imports the seam", () => {
    // Without this, a rename of `buildHintFormat` or of the module would silently reduce the guard
    // above to a test that asserts an empty list is empty, which passes forever and guards nothing.
    const watched = testFiles(TESTS_DIR).filter((file) => importsSeam(readFileSync(file, "utf8")));
    expect(watched.length).toBeGreaterThan(0);
  });
});

describe("test files that reach the seam through the CLI", () => {
  it("pin the retrieval soft budget via TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS, in the file or through the shared setup", () => {
    const envPinned = sharedSetupPinsBudget();
    const offenders = testFiles(TESTS_DIR)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return drivesSeamViaCli(text) && !cliPathPinned(text, envPinned);
      })
      .map(repoRelative);

    expect(offenders).toEqual([]);
  });

  it("is actually watching something -- at least one file runs --hint-format through the CLI", () => {
    const watched = testFiles(TESTS_DIR).filter((file) => drivesSeamViaCli(readFileSync(file, "utf8")));
    expect(watched.length).toBeGreaterThan(0);
    // The in-process door is the one that went red in 0.4.0; make sure it is still recognized.
    expect(watched.map(repoRelative)).toContain("tests/cli.test.ts");
  });

  it("non-firing: files that only mention --hint-format without running the CLI are not flagged", () => {
    // A guard test must not block valid files. This file names the flag in prose and never runs the
    // CLI; a detector keyed on the flag alone would flag it, and this guard would then fail on
    // itself and on every doc-mirror test that quotes the hook command.
    const candidates = testFiles(TESTS_DIR).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /--hint-format/.test(text) && !importsCli(text) && !spawnsBundle(text);
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const file of candidates) {
      expect(drivesSeamViaCli(readFileSync(file, "utf8"))).toBe(false);
    }
  });
});
