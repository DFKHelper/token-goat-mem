/** Source-level guard over every `<receiver>.transaction(...)` in `src/`, found with the TypeScript parser and followed through whatever variable holds it,. better-sqlite3's default `tx()` opens a deferred `BEGIN`: the write lock is taken at the first *write*, not at the first read. Under WAL that means a transaction which reads and then writes can have its snapshot invalidated by a concurrent writer between the two, and SQLite fails it with `SQLITE_BUSY_SNAPSHOT` -- which, unlike plain `SQLITE_BUSY`, `busy_timeout` does not retry. Every such site therefore has to be invoked as `tx.immediate()`, which takes the write lock up front. Nesting matters and is why this guard is source-level rather than behavioral: an inner `db.transaction()` degrades to a SAVEPOINT when an outer transaction is already open, so the *outer* invocation is the one that decides the whole nest's locking mode. A behavioral test would have to lose a genuine race to notice a regression here; a text guard notices the moment the code changes. The window is small and load-dependent -- exactly the kind of defect that ships. If a future transaction genuinely only reads, add it to `READ_ONLY_TRANSACTIONS` with a comment saying why, rather than loosening the rule. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

import ts from "typescript";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Transaction call sites (`file.ts:line`) that provably never read before writing, and so may stay deferred. */
const READ_ONLY_TRANSACTIONS: readonly string[] = [];

/** Transaction call sites invoked `.exclusive()`, each with the reason a plain `.immediate()` would not do; none exists today. */
const EXCLUSIVE_TRANSACTIONS: readonly { readonly site: string; readonly reason: string }[] = [];

interface Allowances {
  readonly readOnly: readonly string[];
  readonly exclusive: readonly { readonly site: string; readonly reason: string }[];
}

interface Scan {
  /** Sites (`file:line  text`) that run, or may run, a transaction deferred or exclusive without an allowance. */
  readonly offenders: string[];
  /** How many transactions are provably invoked `.immediate()`. */
  readonly immediate: number;
}

function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(SRC_DIR, name));
}

/** Whether `node` is a call of a method named `transaction` on any receiver (`db.transaction(fn)`, `live.transaction(fn)`, `x["transaction"](fn)`). */
function isTransactionCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === "transaction";
  }
  return ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === "transaction";
}

/** The nearest function-like or file node around `node`: the scope a transaction variable's uses are searched in (by name, so a same-named variable elsewhere in it is covered too, which can only over-report). */
function enclosingScope(node: ts.Node): ts.Node {
  let current = node.parent;
  while (!ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    current = current.parent;
  }
  return current;
}

/** `node` with any parentheses, non-null assertions and `as` casts around it climbed out of. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isAsExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/** Every `file:line  text` offender in `source`: any receiver's `.transaction(...)` whose invocation is not `.immediate()`, followed through the variable that holds it. */
function scanTransactions(source: string, fileLabel: string, allow: Allowances = { readOnly: READ_ONLY_TRANSACTIONS, exclusive: EXCLUSIVE_TRANSACTIONS }): Scan {
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const offenders = new Set<string>();
  let immediate = 0;

  const report = (node: ts.Node, exclusive: boolean): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    const site = `${fileLabel}:${line + 1}`;
    const allowed = exclusive ? allow.exclusive.some((entry) => entry.site === site && entry.reason.trim() !== "") : allow.readOnly.includes(site);
    if (!allowed) {
      offenders.add(`${site}  ${(lines[line] ?? "").trim()}`);
    }
  };
  /** Classifies one use of a transaction function: `held` is the node standing for it (the call, or a use of the variable holding it). */
  const classifyUse = (held: ts.Node): void => {
    const node = outermost(held);
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === "immediate") {
        immediate++;
      } else {
        report(parent, parent.name.text === "exclusive");
      }
      return;
    }
    report(node, false); // invoked bare (deferred), or passed, returned or stored where its mode cannot be followed
  };
  const classifyVariable = (name: string, scope: ts.Node, declared: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name && node !== declared) {
        const parent = node.parent;
        const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
        const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
        const isDeclaredName = ts.isVariableDeclaration(parent) && parent.name === node;
        if (!isMemberName && !isKey && !isDeclaredName) {
          classifyUse(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  };

  const walk = (node: ts.Node): void => {
    if (isTransactionCall(node)) {
      const held = outermost(node);
      const parent = held.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === held && ts.isIdentifier(parent.name)) {
        classifyVariable(parent.name.text, enclosingScope(parent), parent.name);
      } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === held && ts.isIdentifier(parent.left)) {
        classifyVariable(parent.left.text, enclosingScope(parent), parent.left);
      } else {
        classifyUse(node);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { offenders: [...offenders], immediate };
}

describe("transaction guards", () => {
  it("invokes every .transaction() as .immediate(), so read-then-write pairs cannot lose their snapshot", () => {
    const offenders = sourceFiles().flatMap((file) => scanTransactions(readFileSync(file, "utf8"), basename(file)).offenders);

    expect(offenders).toEqual([]);
  });

  it("still finds transactions to check, so the guard cannot pass by matching nothing", () => {
    const immediate = sourceFiles().reduce((sum, file) => sum + scanTransactions(readFileSync(file, "utf8"), basename(file)).immediate, 0);

    expect(immediate).toBeGreaterThanOrEqual(5);
  });

  describe("scanner self-check: each bypass is reported and each safe shape is not", () => {
    const NONE: Allowances = { readOnly: [], exclusive: [] };
    const cases: readonly { readonly name: string; readonly source: string; readonly offenders: number; readonly immediate: number }[] = [
      { name: "an inline call on the db handle", source: "db.transaction(() => { write(); })();", offenders: 1, immediate: 0 },
      { name: "an inline call on a handle not named db", source: "live.transaction(() => { write(); })();", offenders: 1, immediate: 0 },
      { name: "an inline call spanning lines", source: "db.transaction(() => {\n  read();\n  write();\n})();", offenders: 1, immediate: 0 },
      { name: "a deferred invoke on a handle not named db", source: "live.transaction(fn).deferred();", offenders: 1, immediate: 0 },
      { name: "a variable of any name invoked bare", source: "const run = x.transaction(fn);\nrun();", offenders: 1, immediate: 0 },
      { name: "a variable invoked .deferred()", source: "const tx = db.transaction(fn);\ntx.deferred();", offenders: 1, immediate: 0 },
      { name: "a variable invoked .exclusive() without an allowance", source: "const tx = db.transaction(fn);\ntx.exclusive();", offenders: 1, immediate: 0 },
      { name: "a transaction function returned, so its mode cannot be followed", source: "function make() {\n  return db.transaction(fn);\n}", offenders: 1, immediate: 0 },
      { name: "a transaction function passed on", source: "run(db.transaction(fn));", offenders: 1, immediate: 0 },
      { name: "a variable assigned later and invoked bare", source: "let go;\ngo = db.transaction(fn);\ngo();", offenders: 1, immediate: 0 },
      { name: "an element-access transaction call", source: 'db["transaction"](fn)();', offenders: 1, immediate: 0 },
      { name: "a variable aliased on", source: "const tx = db.transaction(fn);\nconst run = tx;\nrun();", offenders: 1, immediate: 0 },
      { name: "a variable with one immediate and one bare invoke", source: "const tx = db.transaction(fn);\ntx.immediate();\ntx();", offenders: 1, immediate: 1 },
      { name: "an .immediate() on a variable", source: "const tx = db.transaction(fn);\ntx.immediate();", offenders: 0, immediate: 1 },
      { name: "an .immediate() chained on a handle not named db", source: "live.transaction(fn).immediate();", offenders: 0, immediate: 1 },
      { name: "an .immediate() on a parenthesised call", source: "(db.transaction(fn)).immediate();", offenders: 0, immediate: 1 },
      { name: "a property that merely shares the variable's name", source: "const tx = db.transaction(fn);\ntx.immediate();\nother.tx();", offenders: 0, immediate: 1 },
    ];

    it.each(cases)("$name", ({ source, offenders, immediate }) => {
      const scan = scanTransactions(source, "sample.ts", NONE);
      expect(scan.offenders, `offenders for: ${source}`).toHaveLength(offenders);
      expect(scan.immediate, `immediate count for: ${source}`).toBe(immediate);
    });

    it("lets a read-only allowance stand for a deferred site and an exclusive allowance for an exclusive site, only with a reason", () => {
      const deferred = "const tx = db.transaction(fn);\ntx.deferred();";
      expect(scanTransactions(deferred, "sample.ts", { readOnly: ["sample.ts:2"], exclusive: [] }).offenders, "a read-only allowance covers its own line").toEqual([]);
      expect(scanTransactions(deferred, "sample.ts", { readOnly: ["sample.ts:9"], exclusive: [] }).offenders, "an allowance for another line covers nothing").toHaveLength(1);
      const exclusive = "const tx = db.transaction(fn);\ntx.exclusive();";
      expect(scanTransactions(exclusive, "sample.ts", { readOnly: [], exclusive: [{ site: "sample.ts:2", reason: "holds the file lock across a copy" }] }).offenders, "a reasoned exclusive allowance").toEqual([]);
      expect(scanTransactions(exclusive, "sample.ts", { readOnly: [], exclusive: [{ site: "sample.ts:2", reason: " " }] }).offenders, "an exclusive allowance with a blank reason").toHaveLength(1);
      expect(scanTransactions(exclusive, "sample.ts", { readOnly: ["sample.ts:2"], exclusive: [] }).offenders, "a read-only allowance does not cover an exclusive site").toHaveLength(1);
    });
  });
});
