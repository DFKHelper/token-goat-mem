/** Source-level guard that every pretty-printed `--json` output goes through cliRuntime's `formatJson`, so the indent and trailing newline cannot drift per command. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** The one module allowed to call the indented serializer itself. */
const OWNER = "cliRuntime.ts";

/** A `JSON.stringify(<value>, null, <indent>)` call in code; comments are stripped before matching. */
const PRETTY_STRINGIFY = /JSON\.stringify\([^;]*?,\s*null\s*,\s*\d+\s*\)/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("--json output serialization", () => {
  it("only cliRuntime.ts pretty-prints JSON; every other module uses formatJson/writeOutput", () => {
    const offenders = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith(".ts") && name !== OWNER)
      .filter((name) => PRETTY_STRINGIFY.test(stripComments(readFileSync(join(SRC_DIR, name), "utf8"))));
    expect(offenders, "use formatJson/writeOutput from cliRuntime.ts instead of JSON.stringify(x, null, n)").toEqual([]);
  });

  it("the pattern still matches the owner's own serializer, so the guard cannot silently pass", () => {
    expect(PRETTY_STRINGIFY.test(stripComments(readFileSync(join(SRC_DIR, OWNER), "utf8")))).toBe(true);
  });
});
