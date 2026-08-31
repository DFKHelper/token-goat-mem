/**
 * Source-level guard that the `sources` table stays honestly described for as long as it stays unfed.
 *
 * The table, its storage API (`insertSource`/`listSourcesForFact`/`deleteSourcesOlderThan`), its
 * `mem show --json` surfacing and its gc pruning all exist and are tested -- but nothing in the
 * capture path ever writes a row, so it is empty in every real install. That is a deliberate,
 * documented seam, not a bug.
 *
 * What it does create is a claim a consumer cannot check. `mem show --json` emits `"sources": []`
 * for every fact, which reads as "this fact has no recorded sources" when the truth is "mem records
 * no sources at all" -- a well-formed payload indistinguishable from a truthful one, the same class
 * of defect as a seam that withholds facts while its output claims completeness. The disclosure is
 * what makes the empty array legible, so the disclosure has to be maintained.
 *
 * Rather than trust four files to stay in sync by convention, this guard ties them to the code: as
 * long as no `src/` file calls `insertSource`, every surface that mentions `sources` must say it is
 * always empty. The day someone wires the capture path, the guard fails in the other direction and
 * names the disclosures that have become false -- which is exactly when they need removing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

/** Files that must disclose the emptiness, each with the phrase that carries the disclosure. */
const DISCLOSURES: ReadonlyArray<readonly [string, RegExp]> = [
  // The CLI's own `--json` help text -- the surface a user hits without opening any doc.
  ["src/cli.ts", /sources array, which is reserved and always empty/u],
  ["README.md", /reserved `sources` array that is \*\*always empty\*\*/u],
  ["AGENTS.md", /the table is empty in practice/u],
  ["CLAUDE.md", /the table is empty in practice/u],
];

/**
 * Call sites of `insertSource` in `src/`, excluding its own definition. `src/index.ts` re-exports the
 * name in a bare export list with no call parenthesis, so it does not match and needs no special case.
 */
function insertSourceCallSites(): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const text = readFileSync(join(SRC_DIR, entry.name), "utf8");
    text.split("\n").forEach((line, index) => {
      if (/\binsertSource\s*\(/u.test(line) && !/export\s+function\s+insertSource\s*\(/u.test(line)) {
        hits.push(`src/${entry.name}:${index + 1}`);
      }
    });
  }
  return hits;
}

describe("the sources table is described as unfed for exactly as long as it is unfed", () => {
  it("keeps every surface that mentions sources saying it is always empty", () => {
    if (insertSourceCallSites().length > 0) {
      // Handled by the sibling test, which reports the call sites. Skipping the disclosure
      // assertions here keeps that failure readable instead of burying it under four more.
      return;
    }
    for (const [file, phrase] of DISCLOSURES) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        phrase.test(text),
        `${file} no longer discloses that the sources table is always empty. Nothing in src/ writes a ` +
          `source row, so every 'sources' a consumer sees is [] -- which reads as "no sources for this ` +
          `fact" rather than "mem records no sources". Restore the disclosure, or feed the table.`
      ).toBe(true);
    }
  });

  it("fails loudly the moment the capture path starts writing rows, so the disclosures come down with it", () => {
    const callSites = insertSourceCallSites();
    expect(
      callSites,
      `insertSource is now called from ${callSites.join(", ")}. The sources table is fed, so the ` +
        `"always empty" disclosures in ${DISCLOSURES.map(([file]) => file).join(", ")} are false and ` +
        `must be rewritten before this guard is updated.`
    ).toEqual([]);
  });
});
