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
 * Scope, stated honestly: this asserts the *file* defines a pin, not that every call site uses it.
 * A file may legitimately call `buildHintFormat` unpinned -- the scale-invariant test does, because
 * exercising the real default budget is its entire point. What cannot happen after this guard is a
 * new seam test file arriving with no pin at all, which is the failure that actually occurred.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests");

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

/** Whether `text` defines a soft-budget pin for the seam. */
function pinsBudget(text: string): boolean {
  return /\bNO_TRUNCATION_BUDGET_MS\b/.test(text);
}

describe("integration-seam test files", () => {
  it("pin the retrieval soft budget, so a slow runner cannot empty their results", () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return importsSeam(text) && !pinsBudget(text);
      })
      .map((file) => relative(REPO_ROOT, file).replace(/\\/g, "/"));

    expect(offenders).toEqual([]);
  });

  it("is actually watching something -- at least one file imports the seam", () => {
    // Without this, a rename of `buildHintFormat` or of the module would silently reduce the guard
    // above to a test that asserts an empty list is empty, which passes forever and guards nothing.
    const watched = testFiles(TESTS_DIR).filter((file) => importsSeam(readFileSync(file, "utf8")));
    expect(watched.length).toBeGreaterThan(0);
  });
});
