/** Every column of `facts`, parsed from source text with no SQLite: the `CREATE TABLE` in src/db.ts for new stores, plus each `addColumn(db, "facts", "<col>"` call in src/migrations.ts that brings an existing store forward. tests/unit/schema-migration.test.ts cross-checks this set against `PRAGMA table_info(facts)` on a migrated store, so parsing that drifts from the real schema fails there instead of quietly covering less. */
import { readFileSync } from "node:fs";

const src = (name: string): string => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

export function parseFactColumns(): string[] {
  const createTable = /CREATE TABLE IF NOT EXISTS facts \(([\s\S]*?)\n\)/u.exec(src("db.ts"));
  if (createTable === null) {
    throw new Error("could not find the facts CREATE TABLE in src/db.ts");
  }
  const created = [...(createTable[1] ?? "").matchAll(/^\s{2}([a-z_]+)\s/gmu)].map((m) => m[1] ?? "");
  const altered = [...src("migrations.ts").matchAll(/addColumn\(\s*db,\s*"facts",\s*"([a-z_]+)"/gu)].map((m) => m[1] ?? "");
  const all = [...new Set([...created, ...altered])].filter((name) => name.length > 0);
  if (all.length <= 10) {
    throw new Error("no facts columns parsed -- this guard is not looking at what it thinks");
  }
  return all;
}
