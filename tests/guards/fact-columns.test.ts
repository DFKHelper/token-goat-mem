/** Source-level guard over the four hand-maintained lists a `facts` column has to appear in. Adding a column to the schema is one edit; making it actually work is four, in four files, and nothing but memory connects them. The record is bad: `integration-seam.ts`'s hand-written SELECT has silently dropped a needed column three separate times -- `prior_status`, then `scope_repo` (which made every project fact invisible from a worktree), then `capture_root` (which caveated on the hook path a fact the CLI affirmed) -- and `capture_root` also missed `EDITABLE_FACT_FIELDS`, so `mem edit --undo` restored an anchor while leaving it pointed at the wrong tree. Every one of those failed open: no error, no crash, just a quietly different answer on one path. Each omission was preceded by a comment in the very file that drifted, telling the next person to keep the list in step. Three comments, three drifts. This asserts it instead. A column genuinely absent from one of these lists belongs in that list's allowlist below, with a sentence saying why. That turns the next omission into a deliberate, reviewed line rather than a silent divergence discovered a release later. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseFactColumns } from "../support/factColumns.js";

const src = (name: string): string => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

/** The `Fact` field name a `facts` column is carried on. Derived from the `Fact` interface rather than by a naming rule because the interface is not consistent: `scope_root`, `scope_repo` and `capture_root` are camelCased there while `source_type`, `captured_at`, `prior_status` and the rest keep their SQL spelling. Picking whichever form the interface actually declares means this guard keeps working whichever convention a future column follows -- and fails loudly if a column reaches the table with no field to carry it at all. */
function factFieldFor(column: string, factInterface: string): string {
  const camel = column.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  for (const candidate of [column, camel]) {
    if (new RegExp(`\\b${candidate}\\??:`, "u").test(factInterface)) {
      return candidate;
    }
  }
  throw new Error(`the facts table has a column \`${column}\` that the Fact interface declares no field for`);
}

/** The body of the `Fact` interface in src/types.ts, comments stripped so a mention in prose cannot pass for a declaration. */
function factInterfaceBody(): string {
  const body = /export interface Fact \{([\s\S]*?)\n\}/u.exec(src("types.ts"))?.[1] ?? "";
  expect(body, "could not find the Fact interface in src/types.ts").not.toBe("");
  return body.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*/gu, "");
}

describe("guard: a new facts column reaches every hand-maintained list", () => {
  const columns = parseFactColumns();
  const factFields = factInterfaceBody();
  const fieldFor = (column: string): string => factFieldFor(column, factFields);

  it("is written by insertFact", () => {
    const insert = /INSERT INTO facts \(([^)]*)\)/u.exec(src("storage.ts"))?.[1] ?? "";
    expect(insert).not.toBe("");
    for (const column of columns) {
      expect(insert, `insertFact never writes ${column}, so every new row leaves it NULL`).toContain(column);
    }
  });

  it("is selected by the seam's own SELECT and mapped onto the Fact it returns", () => {
    // Deliberate omissions: the hook path has no reader for these, and `embedding` is appended conditionally by the same SELECT because pulling the blob on a path that runs at every prompt costs more than it returns when no embedding backend is configured. `sightings` joins this set for the same reason `terms_checked_at` is already in it: the hook path (`--hint-format`) only ever surfaces ground truth (active/pinned), and `sightings` exists solely to help a human weigh a `pending` fact in `mem review` -- a status the hook path never reads at all. `text_hash` is a storage-internal dedup key derived from `text`; the Fact interface carries no field for it and no hook-path reader wants it.
    const notNeededOnHookPath = new Set(["epoch", "status_changed_at", "last_surfaced_at", "embedding", "terms_checked_at", "sightings", "text_hash"]);
    const seam = src("integration-seam.ts");
    const select = /SELECT id, text[\s\S]*?FROM facts/u.exec(seam)?.[0] ?? "";
    expect(select).not.toBe("");
    for (const column of columns) {
      if (notNeededOnHookPath.has(column)) {
        continue;
      }
      expect(select, `the seam's SELECT omits ${column}; it will read as absent on the hook path only`).toContain(column);
      expect(seam, `the seam selects ${column} but toFact never puts it on the Fact`).toContain(`${fieldFor(column)}:`);
    }
  });

  it("is restored by mem edit --undo, or is deliberately not user-editable", () => {
    // `mem edit` changes what a user stated; these are mem's own bookkeeping about that statement, set by capture and by the status machinery, and an edit must not rewrite them.
    const notUserEditable = new Set([
      "id",
      "kind",
      "source_type",
      "source_ref",
      "captured_at",
      "epoch",
      "status_changed_at",
      "prior_status",
      "last_surfaced_at",
      "embedding",
      "terms_checked_at",
      // A restatement count `recordSighting` (src/capture.ts) increments, never a value a user states or corrects -- there is nothing for `mem edit --scope`/`--text`/etc. to mean here.
      "sightings",
      // A derived hash of `text` that insertFact/updateFact recompute on every write and that only the dedup lookup reads; it is not on the `Fact` interface, so a user edit changes `text` and the hash follows.
      "text_hash",
    ]);
    const editable = /const EDITABLE_FACT_FIELDS = \[([^\]]*)\]/u.exec(src("cli.ts"))?.[1] ?? "";
    expect(editable).not.toBe("");
    for (const column of columns) {
      if (notUserEditable.has(column)) {
        continue;
      }
      expect(
        editable,
        `EDITABLE_FACT_FIELDS omits ${fieldFor(column)}; mem edit --undo will restore the other fields ` +
          "around it and leave this one at its edited value"
      ).toContain(`"${fieldFor(column)}"`);
    }
  });

  it("survives an export/import round trip, or is deliberately local to one store", () => {
    // `epoch` and `status_changed_at` are this store's own clocks: a restored row's status is new news to the destination store, so both start fresh there rather than arriving from elsewhere. `sightings` joins this set: its backing evidence (`sources` rows) is never part of export/ import either (`mem export` carries no `sources` field at all), so a restored store importing a bare count with no excerpts behind it would show a number it cannot account for. Starting fresh at 0 in the destination store is the honest state -- a re-import can then earn its own sighting count the same way any project's first capture does. `text_hash` is recomputed from `text` by insertFact on import, so exporting it would only carry a value the destination derives itself.
    const localToThisStore = new Set(["epoch", "status_changed_at", "terms_checked_at", "sightings", "text_hash"]);
    const exporter = /function factToExportJson[\s\S]*?\n\}/u.exec(src("cli.ts"))?.[0] ?? "";
    expect(exporter).not.toBe("");
    for (const column of columns) {
      if (localToThisStore.has(column)) {
        continue;
      }
      expect(
        exporter,
        `factToExportJson drops ${column}; a restored store will not know it, and mem export calls ` +
          "itself full-fidelity"
      ).toContain(fieldFor(column));
    }
  });
});
