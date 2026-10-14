/** Source-level guard that every test file driving `buildHintFormat` pins the retrieval soft budget. `buildHintFormat` returns an *empty* hint set when it overruns its 150ms soft budget, because TGMEM/2 has no way to express partialness (see RETRIEVAL_BUDGET_MS in src/integration-seam.ts). That is deliberate, and it makes every content assertion against the seam implicitly an assertion about how fast the runner is: on a cold Windows CI runner the budget can go on opening the database alone, and every assertion in the file fails at once for a reason unrelated to what it tests. This is not hypothetical. `tests/unit/integration-seam.test.ts` acquired a budget-pinning wrapper in 0.3.0 after exactly that flake. `tests/integration-seam.test.ts` was left out of that fix, and stayed green only because budget exhaustion then merely *shrank* the result -- a content assertion could still pass against the smaller set. The moment exhaustion started emptying the result instead, the same latent flake turned two Windows CI jobs red. A per-file convention that one file can be added without is not a guarantee; this test is what makes it one. The seam has two doors, and the first version of this guard watched only one. A test file can import `buildHintFormat` and call it, or it can run `mem recall --hint-format` through the CLI (`runCli` in-process, or the built bundle in a subprocess) and reach the seam without ever naming it. `tests/cli-wiring.test.ts` does the latter, was invisible to the import-keyed check, and turned the 0.4.0 release gate red on Windows with the same empty `TGMEM/2` shape. For that door the pin is the `TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS` environment variable, which `src/cli.ts` forwards as `retrievalBudgetMs` on the `--hint-format` path only; the shared setup file sets it once for every in-process file, and a subprocess-driving file inherits it by spreading `process.env` into the child's environment or sets it explicitly. Scope, stated honestly: this asserts the *file* defines a pin, not that every call site uses it. A file may legitimately call `buildHintFormat` unpinned -- the scale-invariant test does, because exercising the real default budget is its entire point. On the CLI side the env-level pin counts as the file's pin: it is process-wide, so a file that wants the real budget through the CLI would have to delete the variable itself, and nothing in the suite does. What cannot happen after this guard is a new seam test file arriving with no pin at all, through either door, which is the failure that actually occurred -- twice. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests");
const SHARED_SETUP = "tests/setup/isolate-home.ts";
const FREEZE_SETUP = "tests/setup/freeze-budget-clock.ts";
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

/** Whether `text` imports `buildHintFormat`, as opposed to merely naming it. Deliberately keyed on the import and not on a `buildHintFormat(` call: `tests/cli-wiring.test.ts` mentions the function in a comment explaining the CLI's fail-open path, and flagging that would be a false positive on a file that never drives the seam at all. */
function importsSeam(text: string): boolean {
  return /import\s+[^;]*\bbuildHintFormat\b[^;]*from\s+["'][^"']*integration-seam\.js["']/s.test(text);
}

/** Whether `text` defines a soft-budget pin for direct `buildHintFormat` calls. */
function pinsBudget(text: string): boolean {
  return /\bNO_TRUNCATION_BUDGET_MS\b/.test(text);
}

/** Whether `text` runs the CLI in-process, either by importing `run` from `src/cli.ts` or by importing `runCli` from `support/cli.js`, which wraps that same in-process `run()`. */
function importsCli(text: string): boolean {
  return (
    /import\s+[^;]*\brun\b[^;]*from\s+["'][^"']*src\/cli\.js["']/s.test(text) ||
    /import\s+[^;]*\brunCli\b[^;]*from\s+["'][^"']*support\/cli\.js["']/s.test(text)
  );
}

/** Whether `text` runs the built bundle in a subprocess. */
function spawnsBundle(text: string): boolean {
  return /token-goat-mem\.mjs/.test(text);
}

/** Whether `text` reaches the seam through the CLI: it passes `--hint-format` and has a way to run the CLI. Both halves are required so a file that merely quotes the flag in a comment or asserts on help text is not a false positive. */
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

/** Whether the shared setup file pins the budget for every in-process test, and is actually wired into vitest so that pin runs. Both are checked because either one going missing silently unpins every CLI-path file at once. */
function sharedSetupPinsBudget(setupText: string, configText: string): boolean {
  // Keyed on the assignment, not on the variable's name, and anchored to the start of a line: the setup file names the variable in a constant and a comment, and a commented-out assignment (`// process.env[...] = ...`) runs nothing, so with only those left the pin would read as present while every CLI-path file ran against the real budget.
  const declaresName = /^const RETRIEVAL_BUDGET_ENV = "TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS"/m.test(setupText);
  const assigns = /^[ \t]*process\.env\[RETRIEVAL_BUDGET_ENV\] = NO_TRUNCATION_BUDGET_MS;/m.test(setupText);
  return declaresName && assigns && configText.includes(SHARED_SETUP);
}

/** Whether a CLI-path file is pinned. Naming the variable itself always counts. Otherwise the shared setup's env pin counts, because an in-process `runCli` reads the worker's `process.env` and a spawned child inherits it unless the file builds the child an explicit environment. A file that does build one must spread `process.env` into it: a child given a fresh environment sees the real 150ms budget no matter what the parent set. */
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
    // Without this, a rename of `buildHintFormat` or of the module would silently reduce the guard above to a test that asserts an empty list is empty, which passes forever and guards nothing.
    const watched = testFiles(TESTS_DIR).filter((file) => importsSeam(readFileSync(file, "utf8")));
    expect(watched.length).toBeGreaterThan(0);
  });
});

describe("test files that reach the seam through the CLI", () => {
  it("pin the retrieval soft budget via TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS, in the file or through the shared setup", () => {
    const envPinned = sharedSetupPinsBudget(readRepoFile(SHARED_SETUP), readRepoFile(VITEST_CONFIG));
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
    expect(watched.map(repoRelative)).toContain("tests/cli-wiring.test.ts");
    // The shared `runCli` helper is the door most CLI test files use; make sure it is recognized too.
    expect(watched.map(repoRelative)).toContain("tests/cli-recall.test.ts");
  });

  it("non-firing: files that only mention --hint-format without running the CLI are not flagged", () => {
    // A guard test must not block valid files. This file names the flag in prose and never runs the CLI; a detector keyed on the flag alone would flag it, and this guard would then fail on itself and on every doc-mirror test that quotes the hook command.
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

/** Whether the setup file that freezes the budget clock still mocks `budgetNow` and is wired into vitest. Both are checked, as for the env pin: the mock line missing, commented out (it then runs nothing), or the file dropped from `setupFiles` each leave every anchor and embedding budget racing the real clock again, with no test failing until a slow machine runs one out. */
function sharedSetupFreezesBudgetClock(freezeText: string, configText: string): boolean {
  const mocks = /^vi\.mock\("\.\.\/\.\.\/src\/budgetClock\.js", \(\) => \(\{ budgetNow: \(\) => FROZEN_BUDGET_NOW_MS \}\)\);/m.test(freezeText);
  return mocks && configText.includes(FREEZE_SETUP);
}

/** Whether a src file reads its deadlines off the budget clock: it imports `budgetNow` and, where `allowWallClock` is false, names no `Date.now(` at all. anchors.ts keeps one legitimate wall-clock read (`valid-until` compares a calendar date), so it is checked on `budgetExceeded` alone. */
function readsBudgetClock(text: string, allowWallClock: boolean): boolean {
  const imports = /^import \{ budgetNow \} from "\.\/budgetClock\.js";/m.test(text);
  return imports && (allowWallClock || !/\bDate\.now\(/.test(text));
}

describe("the budget clock freeze", () => {
  const freezeText = readRepoFile(FREEZE_SETUP);
  const configText = readRepoFile(VITEST_CONFIG);
  const mockLine = /^vi\.mock\(.*$/m.exec(freezeText)?.[0] ?? "";

  it("accepts the real freeze setup file wired into the real vitest config", () => {
    expect(mockLine).not.toBe("");
    expect(sharedSetupFreezesBudgetClock(freezeText, configText)).toBe(true);
  });

  it("reports the freeze missing when the setup file no longer mocks the clock", () => {
    const withoutMock = freezeText.replace(mockLine, "");
    expect(withoutMock).not.toBe(freezeText);
    expect(sharedSetupFreezesBudgetClock(withoutMock, configText)).toBe(false);
  });

  it("reports the freeze missing when the mock line is commented out", () => {
    const commentedOut = freezeText.replace(mockLine, `// ${mockLine}`);
    expect(commentedOut).not.toBe(freezeText);
    expect(sharedSetupFreezesBudgetClock(commentedOut, configText)).toBe(false);
  });

  it("reports the freeze missing when vitest no longer wires the setup file", () => {
    const unwired = configText.split(FREEZE_SETUP).join("tests/setup/elsewhere.ts");
    expect(unwired).not.toBe(configText);
    expect(sharedSetupFreezesBudgetClock(freezeText, unwired)).toBe(false);
  });

  it("is what every deadline in the retrieval path reads: anchors, retrieval and the seam use budgetNow, not Date.now", () => {
    const anchorsText = readRepoFile("src/anchors.ts");
    const budgetExceededBody = /function budgetExceeded\([^)]*\): boolean \{[^}]*\}/.exec(anchorsText)?.[0] ?? "";
    expect(budgetExceededBody).toContain("budgetNow()");
    expect(budgetExceededBody).not.toContain("Date.now(");
    expect(readsBudgetClock(anchorsText, true)).toBe(true);
    expect(readsBudgetClock(readRepoFile("src/retrieval.ts"), false)).toBe(true);
    expect(readsBudgetClock(readRepoFile("src/integration-seam.ts"), false)).toBe(true);
  });

  it("flags a src file that still reads a deadline off the wall clock", () => {
    const wallClock = ['import { budgetNow } from "./budgetClock.js";', "const deadline = Date.now() + 100;"].join("\n");
    expect(readsBudgetClock(wallClock, false)).toBe(false);
    expect(readsBudgetClock("const deadline = Date.now() + 100;", true)).toBe(false);
  });
});

/** The source with every whole-line comment dropped, so a comment that names `AbortSignal.timeout` to explain why it is not used is not read as a call. */
function withoutCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*\*)/.test(line))
    .join("\n");
}

/** Whether the embedding request deadline is read off the budget clock: embeddings.ts takes its abort signal from `startBudgetTimeout` and never builds an `AbortSignal.timeout`, and budgetTimer.ts reads `budgetNow` and names no `Date.now(`. A wall-clock abort in embeddings.ts is the one deadline the frozen clock cannot reach, so a slow machine could still time a localhost round trip out. */
function embeddingDeadlineOnBudgetClock(embeddingsText: string, timerText: string): boolean {
  const code = withoutCommentLines(embeddingsText);
  const takesBudgetSignal = /^import \{ startBudgetTimeout \} from "\.\/budgetTimer\.js";/m.test(code) && /\bstartBudgetTimeout\(/.test(code);
  const timerReadsClock = /^import \{ budgetNow \} from "\.\/budgetClock\.js";/m.test(timerText) && !/\bDate\.now\(/.test(timerText);
  return takesBudgetSignal && !/\bAbortSignal\.timeout\(/.test(code) && timerReadsClock;
}

describe("the embedding request deadline", () => {
  const embeddingsText = readRepoFile("src/embeddings.ts");
  const timerText = readRepoFile("src/budgetTimer.ts");

  it("accepts the real embeddings backend and budget timer", () => {
    expect(embeddingDeadlineOnBudgetClock(embeddingsText, timerText)).toBe(true);
  });

  it("flags embeddings.ts when it builds an AbortSignal.timeout again", () => {
    const wallClockAbort = embeddingsText.replace("        signal,\n", "        signal: AbortSignal.timeout(timeoutMs),\n");
    expect(wallClockAbort).not.toBe(embeddingsText);
    expect(embeddingDeadlineOnBudgetClock(wallClockAbort, timerText)).toBe(false);
  });

  it("flags embeddings.ts when it stops reading the budget clock", () => {
    const withoutImport = embeddingsText.replace('import { startBudgetTimeout } from "./budgetTimer.js";', "");
    expect(withoutImport).not.toBe(embeddingsText);
    expect(embeddingDeadlineOnBudgetClock(withoutImport, timerText)).toBe(false);
    const withoutCall = embeddingsText.split("startBudgetTimeout(").join("startDeadline(");
    expect(withoutCall).not.toBe(embeddingsText);
    expect(embeddingDeadlineOnBudgetClock(withoutCall, timerText)).toBe(false);
  });

  it("flags the budget timer when it reads the wall clock", () => {
    const wallClock = timerText.replace("budgetNow() + ms", "Date.now() + ms");
    expect(wallClock).not.toBe(timerText);
    expect(embeddingDeadlineOnBudgetClock(embeddingsText, wallClock)).toBe(false);
    const noClockImport = timerText.replace('import { budgetNow } from "./budgetClock.js";', "");
    expect(noClockImport).not.toBe(timerText);
    expect(embeddingDeadlineOnBudgetClock(embeddingsText, noClockImport)).toBe(false);
  });

  it("does not flag a comment that names AbortSignal.timeout", () => {
    const withComment = `// AbortSignal.timeout(timeoutMs) is not used here.\n${embeddingsText}`;
    expect(embeddingDeadlineOnBudgetClock(withComment, timerText)).toBe(true);
  });
});

describe("the shared pin detection itself", () => {
  const setupText = readRepoFile(SHARED_SETUP);
  const configText = readRepoFile(VITEST_CONFIG);
  const pinLine = /^.*process\.env\[RETRIEVAL_BUDGET_ENV\] = NO_TRUNCATION_BUDGET_MS;.*$/m.exec(setupText)?.[0] ?? "";
  const setupWithoutPin = setupText.replace(pinLine, "");

  it("accepts the real setup file wired into the real vitest config", () => {
    expect(pinLine).not.toBe("");
    expect(sharedSetupPinsBudget(setupText, configText)).toBe(true);
  });

  it("reports the pin missing when the setup file no longer assigns it", () => {
    expect(setupWithoutPin).not.toBe(setupText);
    expect(sharedSetupPinsBudget(setupWithoutPin, configText)).toBe(false);
  });

  it("reports the pin missing when the setup file's assignment is commented out", () => {
    const commentedOut = setupText.replace(pinLine, `// ${pinLine.trim()}`);
    expect(commentedOut).not.toBe(setupText);
    expect(sharedSetupPinsBudget(commentedOut, configText)).toBe(false);
  });

  it("reports the pin missing when vitest no longer wires the setup file", () => {
    const unwired = configText.split(SHARED_SETUP).join("tests/setup/elsewhere.ts");
    expect(unwired).not.toBe(configText);
    expect(sharedSetupPinsBudget(setupText, unwired)).toBe(false);
  });

  it("flags a CLI-path test file with no local pin when the shared pin is absent", () => {
    const cliTest = [
      'import { runCli } from "../support/cli.js";',
      'it("recalls the hint", async () => {',
      '  await runCli(["recall", "--hint-format"]);',
      "});",
    ].join("\n");
    expect(drivesSeamViaCli(cliTest)).toBe(true);
    expect(cliPathPinned(cliTest, sharedSetupPinsBudget(setupText, configText))).toBe(true);
    expect(cliPathPinned(cliTest, sharedSetupPinsBudget(setupWithoutPin, configText))).toBe(false);
  });
});
