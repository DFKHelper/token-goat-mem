/**
 * Source-level guard that a test asserting on an error class also says *which* failure it expected,
 * whenever the class alone cannot say it.
 *
 * `expect(...).toThrow(SomeError)` passes for any instance of that class, from any code path. When
 * one class covers a single failure that is exactly the right assertion. When it covers several, the
 * assertion silently weakens into "something went wrong", and a test can pass on a failure that has
 * nothing to do with what it is named for.
 *
 * That is not theoretical here. `tests/exportImport.test.ts` had a test called "an oversized import
 * file throws JsonImportError before attempting to parse" that asserted only the class. A 50MB file
 * of filler is not valid JSON either, so the parse failure raised the same class and satisfied the
 * assertion -- the test passed with the size limit raised tenfold, meaning the guard it was named
 * for had never been covered at all. The test was passing *on the parse* it existed to rule out.
 *
 * ── The ambiguity model ─────────────────────────────────────────────────────────────────────────
 *
 * A class is "ambiguous" when `src/` can raise it carrying more than one distinct message. Counting
 * `new X(` alone undercounts: `readFileWithErrorMapping` (src/fileUtils.ts) constructs *the caller's*
 * class, so a class handed to it picks up every message branch that helper has -- which is how
 * `JsonImportError` reaches nine possible messages from five direct `throw` sites.
 *
 * A class with exactly one message is left alone: `toThrow(SecretDetectedError)` is unambiguous by
 * construction, and demanding a message there would be ceremony, not coverage. A class defined
 * inside the test file itself is also exempt -- `tests/unit/fileUtils.test.ts` passes `TestError` and
 * `OtherError` *in* to prove the mapper returns the class it was given, so there the class is the
 * assertion rather than a proxy for one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const TESTS_DIR = join(REPO_ROOT, "tests");

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const SRC_FILES = filesUnder(SRC_DIR);
const SRC_TEXT = SRC_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
const FILE_UTILS_TEXT = readFileSync(join(SRC_DIR, "fileUtils.ts"), "utf8");

/** How many message branches the generic file-error mapper can construct the caller's class with. */
const MAPPER_MESSAGE_BRANCHES = FILE_UTILS_TEXT.match(/new ErrorClass\(/g)?.length ?? 0;

/** How many distinct messages `src/` can raise `errorClass` with. */
function distinctMessageCount(errorClass: string): number {
  const direct = SRC_TEXT.match(new RegExp(String.raw`new ${errorClass}\(`, "g"))?.length ?? 0;
  const viaMapper = new RegExp(String.raw`readFileWithErrorMapping\([^)]*,\s*${errorClass}\s*\)`).test(SRC_TEXT);
  return direct + (viaMapper ? MAPPER_MESSAGE_BRANCHES : 0);
}

/** Splits a test file into its individual `it(...)` / `test(...)` bodies. Crude on purpose -- a block that over-reads only makes this guard more lenient, never wrong. */
function testBlocks(text: string): string[] {
  return text.split(/\n\s*(?:it|test)(?:\.\w+)*\s*\(/);
}

/** Whether a block asserts on the error's *message*, in any of the forms this suite uses. */
function assertsMessage(block: string): boolean {
  return (
    /toThrow\(\s*[/`"']/.test(block) ||
    /toThrowError\(\s*[/`"']/.test(block) ||
    /\.message\s*\)\s*\.\s*(toContain|toMatch|toBe)\(/.test(block)
  );
}

const BARE_CLASS_ASSERTION = /toThrow(?:Error)?\(\s*([A-Z][A-Za-z0-9_]*(?:Error|Exception))\s*\)/g;

interface Offender {
  readonly file: string;
  readonly errorClass: string;
  readonly messages: number;
}

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of filesUnder(TESTS_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const block of testBlocks(text)) {
      for (const match of block.matchAll(BARE_CLASS_ASSERTION)) {
        const errorClass = match[1] as string;
        // Defined in the test file itself: the class *is* what the test is proving.
        if (new RegExp(String.raw`class ${errorClass}\b`).test(text)) {
          continue;
        }
        const messages = distinctMessageCount(errorClass);
        if (messages > 1 && !assertsMessage(block)) {
          offenders.push({ file: relative(REPO_ROOT, file).replace(/\\/g, "/"), errorClass, messages });
        }
      }
    }
  }
  return offenders;
}

describe("error-class assertions", () => {
  it("say which failure they expected, wherever the class alone cannot", () => {
    expect(findOffenders()).toEqual([]);
  });

  it("is actually watching something -- the ambiguity model finds real multi-message classes", () => {
    // Without this, a rename of an error class or of the mapper would drop every class to a count of
    // 0 or 1, making the guard above vacuously true and silent about it forever.
    expect(MAPPER_MESSAGE_BRANCHES).toBeGreaterThan(1);
    expect(distinctMessageCount("WiringConflictError")).toBeGreaterThan(1);
    expect(distinctMessageCount("JsonImportError")).toBeGreaterThan(1);
    // ...and stays narrow: a single-message class must not be swept in, or the guard becomes noise.
    expect(distinctMessageCount("SecretDetectedError")).toBe(1);
  });
});
