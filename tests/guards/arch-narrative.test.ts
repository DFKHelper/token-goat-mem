/**
 * Guard that ARCHITECTURE.md's hand-written narrative keeps up with the schema.
 *
 * `arch-docs.test.ts` covers the *generated* component table, and covers it completely -- but only
 * what lives between the `ARCH_COMPONENTS` markers. The prose above them is where the load-bearing
 * shape decisions are recorded, and `sync-arch-docs.mjs` deliberately never touches it, so nothing
 * was checking it at all. Two tables (`anchor_cache`, `fact_links`) were created, wired, and shipped
 * without a sentence anywhere in the document, and every gate passed the whole time.
 *
 * A table is the right unit to key this on: it is the one schema object that cannot be introduced
 * without a deliberate migration step, it is discoverable from the source with a regex rather than a
 * parser, and "this store now persists a new kind of thing" is precisely the class of decision the
 * narrative exists to explain. This does not (and cannot) check that what the prose *says* is true;
 * it checks that the prose says something, which is the failure that actually occurred.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");

/** Marker pair `scripts/sync-arch-docs.mjs` splices between -- everything outside it is hand-written. */
const START_MARKER = "<!-- ARCH_COMPONENTS_START -->";
const END_MARKER = "<!-- ARCH_COMPONENTS_END -->";

/**
 * The narrative only, with the generated table cut out. Without this, a table name appearing in a
 * generated Role or export list would satisfy the guard without any human having explained anything.
 */
function readNarrative(): string {
  const doc = readFileSync(join(REPO_ROOT, "ARCHITECTURE.md"), "utf8");
  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  expect(start, "ARCHITECTURE.md is missing the ARCH_COMPONENTS_START marker").toBeGreaterThanOrEqual(0);
  expect(end, "ARCHITECTURE.md is missing the ARCH_COMPONENTS_END marker").toBeGreaterThan(start);
  return doc.slice(0, start) + doc.slice(end + END_MARKER.length);
}

/** Every table `migrations.ts` creates, in declaration order. */
function migrationTableNames(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "migrations.ts"), "utf8");
  return [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gu)].map((match) => match[1] ?? "");
}

describe("ARCHITECTURE.md narrative keeps up with the schema", () => {
  it("names every table src/migrations.ts creates", () => {
    const narrative = readNarrative();
    const tables = migrationTableNames();
    // A guard that silently checks nothing is worse than no guard: if the regex above ever stops
    // matching (a reformatted `CREATE TABLE`, a renamed migration file), this is what says so.
    expect(tables.length, "no CREATE TABLE statements found in src/migrations.ts -- the extraction regex has gone stale").toBeGreaterThan(0);

    const undocumented = tables.filter((table) => !narrative.includes(table));
    expect(
      undocumented,
      `ARCHITECTURE.md's narrative never mentions: ${undocumented.join(", ")}. A new table is a new kind of persisted state; say what it holds and why, outside the generated markers.`
    ).toEqual([]);
  });
});
