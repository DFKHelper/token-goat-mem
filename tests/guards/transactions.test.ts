/**
 * Source-level guard over every `db.transaction(...)` in `src/`.
 *
 * better-sqlite3's default `tx()` opens a deferred `BEGIN`: the write lock is taken at the first
 * *write*, not at the first read. Under WAL that means a transaction which reads and then writes can
 * have its snapshot invalidated by a concurrent writer between the two, and SQLite fails it with
 * `SQLITE_BUSY_SNAPSHOT` -- which, unlike plain `SQLITE_BUSY`, `busy_timeout` does not retry. Every
 * such site therefore has to be invoked as `tx.immediate()`, which takes the write lock up front.
 *
 * Nesting matters and is why this guard is source-level rather than behavioral: an inner
 * `db.transaction()` degrades to a SAVEPOINT when an outer transaction is already open, so the
 * *outer* invocation is the one that decides the whole nest's locking mode. A behavioral test would
 * have to lose a genuine race to notice a regression here; a text guard notices the moment the code
 * changes. The window is small and load-dependent -- exactly the kind of defect that ships.
 *
 * If a future transaction genuinely only reads, add it to `READ_ONLY_TRANSACTIONS` with a comment
 * saying why, rather than loosening the rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Transaction call sites that provably never read before writing, and so may stay deferred. */
const READ_ONLY_TRANSACTIONS: readonly string[] = [];

function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(SRC_DIR, name));
}

describe("transaction guards", () => {
  it("invokes every db.transaction() as .immediate(), so read-then-write pairs cannot lose their snapshot", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        // A bare `tx();` / `return tx();` invocation of a transaction function. `tx.immediate()`,
        // `tx.exclusive()`, and `tx.deferred()` all carry an explicit mode and are not matched here.
        const match = /(?:^|[\s(=])((?:const |let )?\w*[tT]x)\(\)/u.exec(line);
        if (match === null || /\.(?:immediate|exclusive|deferred)\(\)/u.test(line)) {
          return;
        }
        if (/db\.transaction\(/u.test(line)) {
          return; // the definition, not an invocation
        }
        const site = `${file.split(/[\\/]/u).pop() ?? file}:${index + 1}`;
        if (!READ_ONLY_TRANSACTIONS.includes(site)) {
          offenders.push(`${site}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("still finds transactions to check, so the guard cannot pass by matching nothing", () => {
    const immediateSites = sourceFiles()
      .flatMap((file) => readFileSync(file, "utf8").split("\n"))
      .filter((line) => /\btx\.immediate\(\)/u.test(line));

    expect(immediateSites.length).toBeGreaterThanOrEqual(5);
  });
});
