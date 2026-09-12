/**
 * Source-level guard that the `sources` table is fed from exactly the two capture paths designed to
 * feed it -- `mem scan-session` and `mem import --from-md` -- and from nowhere else.
 *
 * The table used to be wired but genuinely empty: storage API, `mem show --json` surfacing, and gc
 * pruning all existed and were tested, but no capture path ever called `insertSource`. That state had
 * its own guard (this file, previously), which asserted the emptiness and the four disclosures of it.
 * Once fed, the risk inverts: a `sources` row now carries real excerpt text, so the boundary that
 * matters is *which* paths write one, not whether any do. `mem remember`/`mem suggest <text>` must
 * never write a source row (the caller's text already is the fact there -- a row would just echo it
 * back), and every excerpt that is written must have gone through truncation and secret screening
 * first, per storage.ts's Source doc ("storage.ts does not screen or truncate content itself").
 *
 * `insertSource` itself is called from exactly one place (`capture.ts`'s `writeFact`, gated on the
 * caller having set `sourceExcerpt`), so this guard checks the layer above it: which `captureSuggested`
 * call sites set `sourceExcerpt` at all, keyed on file rather than the shared `sourceExcerpt` field
 * name so a future third derived-capture path is caught by omission from ALLOWED_EXCERPT_FILES, not
 * waved through because it also happens to say `sourceExcerpt`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files whose `sources` disclosure must name both feeding paths, each with the phrase that carries it. */
const DISCLOSURES: ReadonlyArray<readonly [string, RegExp]> = [
  // The CLI's own `--json` help text -- the surface a user hits without opening any doc.
  ["src/cli.ts", /fed only by mem scan-session and mem import --from-md/u],
  ["README.md", /fed only by `mem scan-session` and `mem import --from-md`/u],
  ["AGENTS.md", /Fed from exactly two capture paths where the raw material is genuinely larger than the fact/u],
  ["CLAUDE.md", /Fed from exactly two capture paths where the raw material is genuinely larger than the fact/u],
];

/** The only files allowed to set `sourceExcerpt` on a `CaptureSuggestedInput` -- scan-session's and --from-md's CLI/library wiring. `capture.ts` itself is exempt: it only reads the field back off `input`, never sets it. */
const ALLOWED_EXCERPT_FILES = new Set(["src/cli.ts", "src/import.ts"]);

/**
 * `sourceExcerpt` assignment sites in `src/`, as `file:line` -- places that *set* a
 * `CaptureSuggestedInput.sourceExcerpt` field, as `{ sourceExcerpt }` shorthand or `const
 * sourceExcerpt = ...`. Excludes the interface field declaration (`readonly sourceExcerpt?:`),
 * capture.ts's own read of `input.sourceExcerpt` when handing it to `writeFact`, and
 * `writeFact`/`insertSource`'s unrelated `excerpt: sourceExcerpt` parameter (a different field,
 * `sources.excerpt`, merely populated *from* the value read out of `input.sourceExcerpt`).
 */
function sourceExcerptAssignmentSites(): string[] {
  const hits: string[] = [];
  for (const rel of ["src/cli.ts", "src/capture.ts", "src/import.ts", "src/exportImport.ts", "src/sessionScan.ts"]) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    text.split("\n").forEach((line, index) => {
      if (
        (/\{\s*sourceExcerpt\s*\}/u.test(line) || /\bconst\s+sourceExcerpt\s*=/u.test(line)) &&
        !/readonly\s+sourceExcerpt/u.test(line)
      ) {
        hits.push(`${rel}:${index + 1}`);
      }
    });
  }
  return hits;
}

describe("the sources table is fed from exactly the two derived-capture paths designed to feed it", () => {
  it("sets sourceExcerpt only from mem scan-session and mem import --from-md", () => {
    const sites = sourceExcerptAssignmentSites();
    expect(sites.length, "expected at least one sourceExcerpt assignment site once the table is fed").toBeGreaterThan(0);
    for (const site of sites) {
      const [file] = site.split(":");
      expect(
        ALLOWED_EXCERPT_FILES.has(file as string),
        `${site} sets sourceExcerpt, but only ${[...ALLOWED_EXCERPT_FILES].join(", ")} may -- mem remember/mem ` +
          `suggest must never write a source row (the caller's text already is the fact there).`
      ).toBe(true);
    }
  });

  it("never sets sourceExcerpt on mem suggest's captureSuggested call", () => {
    const cliText = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const suggestCommandStart = cliText.indexOf('.command("suggest <text>")');
    const nextCommandStart = cliText.indexOf('.command(', suggestCommandStart + 1);
    expect(suggestCommandStart, "mem suggest command block not found -- guard needs updating for a renamed command").toBeGreaterThan(-1);
    const suggestBlock = cliText.slice(suggestCommandStart, nextCommandStart === -1 ? undefined : nextCommandStart);
    expect(
      suggestBlock.includes("sourceExcerpt"),
      "mem suggest's captureSuggested call now sets sourceExcerpt -- it must not: the user's own text " +
        "there is the fact, and a source row echoing it back would be provenance noise, not evidence."
    ).toBe(false);
  });

  it("truncates and secret-screens every excerpt before it can be stored", () => {
    const captureText = readFileSync(join(REPO_ROOT, "src/capture.ts"), "utf8");
    expect(captureText).toMatch(/MAX_SOURCE_EXCERPT_LENGTH/u);
    expect(captureText).toMatch(/function buildScreenedExcerpt/u);
    // buildScreenedExcerpt must route through screenForSecrets and truncate against the cap --
    // asserted structurally here; the behavioral proof (screened-positive => null, over-cap => cut)
    // lives in tests/unit/capture.test.ts.
    const fnStart = captureText.indexOf("export function buildScreenedExcerpt");
    const fnEnd = captureText.indexOf("\n}", fnStart);
    const fnBody = captureText.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/screenForSecrets/u);
    expect(fnBody).toMatch(/MAX_SOURCE_EXCERPT_LENGTH/u);
  });

  it("keeps every surface that mentions sources naming both feeding paths", () => {
    for (const [file, phrase] of DISCLOSURES) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        phrase.test(text),
        `${file} no longer names mem scan-session and mem import --from-md as the two paths that feed ` +
          `sources, and their exclusion of mem remember/mem suggest -- restore the disclosure, or update ` +
          `this guard if the feeding paths genuinely changed.`
      ).toBe(true);
    }
  });
});
