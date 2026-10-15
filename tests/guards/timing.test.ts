/** Source-level guard that no test waits on, or asserts about, the wall clock: a fixed delay of 100 ms or more, an elapsed-time assertion, a per-test timeout above the 30 s default in vitest.config.ts, or the retired spawn-timeout floor. All of these pass on a quiet machine and fail on a slow one, and a longer number only moves the failure to the next slower machine. It parses every test source under tests/ with the TypeScript compiler (a dev dependency the comment guard already uses), in-process: it spawns nothing and sets no timeout of its own. The guard file is excluded because its fixtures spell the patterns out. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "guards/timing.test.ts";
const SOURCE_EXTENSION = /\.(ts|mts|mjs|js)$/u;

/** A delay at or above this is a real wait, not a yield. */
const MIN_FLAGGED_DELAY_MS = 100;
/** The per-test ceiling: vitest.config.ts testTimeout. */
const MAX_TIMEOUT_MS = 30_000;
/** The object keys that are vitest timeout options, plus `timeout` itself. */
const TIMEOUT_KEYS = new Set(["timeout", "testTimeout", "hookTimeout"]);
/** Callee roots whose trailing numeric argument is a vitest per-test timeout. */
const TEST_CALL_ROOTS = new Set(["it", "test", "describe", "suite", "beforeAll", "beforeEach", "afterAll", "afterEach"]);

type Rule = "sleep" | "clock-assertion" | "timeout" | "spawn-floor";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
  readonly detail: string;
  readonly lineText: string;
}

interface AllowEntry {
  /** Path under tests/, forward slashes. */
  readonly file: string;
  /** Matched against the trimmed text of the offending line. */
  readonly line: RegExp;
  /** One line: why this is a delay that is not a test wait. */
  readonly reason: string;
}

/** Starts empty and stays empty unless a delay is genuinely not a test wait (a shim that must hang, say); each entry names its file, the line pattern and a one-line reason. */
const ALLOWLIST: readonly AllowEntry[] = [];

const FIXES: Record<Rule, string> = {
  sleep: "wait on a condition (an event, a promise the code under test settles, an in-process call) instead of a delay",
  "clock-assertion": "assert on an observable result or an injected clock, never on elapsed wall-clock time",
  timeout: `remove the override and make the test fit the ${MAX_TIMEOUT_MS} ms default in vitest.config.ts; a longer timeout only moves the failure to a slower machine`,
  "spawn-floor": "delete the reference; the spawn timeout floor is gone and no test sets a spawn timeout of its own",
};

function describeViolation(violation: Violation): string {
  return `${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}. Fix: ${FIXES[violation.rule]}. Line: ${violation.lineText}`;
}

/** Evaluates a numeric literal or an arithmetic expression over literals and same-file constants; `undefined` when it is anything else. */
function evalNumber(node: ts.Node, consts: ReadonlyMap<string, ts.Expression>, depth = 0): number | undefined {
  if (depth > 8) {
    return undefined;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalNumber(node.expression, consts, depth + 1);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = evalNumber(node.operand, consts, depth + 1);
    return operand === undefined ? undefined : -operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evalNumber(node.left, consts, depth + 1);
    const right = evalNumber(node.right, consts, depth + 1);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return left / right;
      default:
        return undefined;
    }
  }
  if (ts.isIdentifier(node)) {
    const initializer = consts.get(node.text);
    return initializer === undefined ? undefined : evalNumber(initializer, consts, depth + 1);
  }
  return undefined;
}

function isClockCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 0 || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const owner = node.expression.expression;
  return ts.isIdentifier(owner) && (owner.text === "Date" || owner.text === "performance") && node.expression.name.text === "now";
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

/** The identifier at the root of `it`, `it.skip`, `it.each(table)` and the like. */
function calleeRoot(call: ts.CallExpression): string | undefined {
  let node: ts.Expression = call.expression;
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

/** Every violation in one test source. Recognised shapes: `setTimeout(fn, ms)`, `setTimeout(ms)` and `sleep(ms)` with a delay of 100 ms or more; a clock difference between two clock reads (`Date.now() - startedAt`, `end - start`) written inside an `expect(...)` chain or held in a variable that reaches one; `timeout`, `testTimeout` and `hookTimeout` object keys and a trailing numeric argument of `it`/`test`/`describe`/a hook above 30 s; any text mention of the spawn timeout floor. Numbers resolve through literals, arithmetic and same-file `const`s; a `timeout:` key whose bare-identifier value cannot be resolved is reported as unresolved, while a call-expression value (a hook entry's `timeout: claudeHookTimeoutSeconds(...)`), an identifier any declaration of which in this file is bound to one, and a parameter type annotation (`timeout: number`) are not vitest options and are left alone. A clock minus a literal or a constant (`Date.now() - 86_400_000`) is fixture arithmetic that builds an old timestamp, not a measurement. */
function scanSource(file: string, text: string): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const found = new Map<string, Violation>();
  const report = (node: ts.Node, rule: Rule, detail: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.set(`${line}:${rule}`, { file, line, rule, detail, lineText: (lines[line - 1] ?? "").trim() });
  };

  const consts = new Map<string, ts.Expression>();
  const declarations: ts.VariableDeclaration[] = [];
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      declarations.push(node);
      if (!consts.has(node.name.text)) {
        consts.set(node.name.text, node.initializer);
      }
    }
  });

  const clockVars = new Set<string>();
  for (const declaration of declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && isClockCall(declaration.initializer)) {
      clockVars.add(declaration.name.text);
    }
  }
  const isClockValue = (node: ts.Node): boolean => isClockCall(node) || (ts.isIdentifier(node) && clockVars.has(node.text));
  const isMeasurement = (node: ts.Node): boolean =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken && isClockValue(node.left) && isClockValue(node.right);
  const findMeasurement = (root: ts.Node): ts.Node | undefined => {
    let hit: ts.Node | undefined;
    walk(root, (node) => {
      if (hit === undefined && isMeasurement(node)) {
        hit = node;
      }
    });
    return hit;
  };
  const measuredVars = new Set<string>();
  for (const declaration of declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && findMeasurement(declaration.initializer) !== undefined) {
      measuredVars.add(declaration.name.text);
    }
  }

  const isComputedConst = (identifier: ts.Identifier): boolean =>
    declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text && declaration.initializer !== undefined && ts.isCallExpression(declaration.initializer));
  const checkTimeoutValue =(value: ts.Expression, keyNode: ts.Node, key: string): void => {
    const ms = evalNumber(value, consts);
    if (ms !== undefined) {
      if (ms > MAX_TIMEOUT_MS) {
        report(keyNode, "timeout", `\`${key}\` of ${ms} ms is above the ${MAX_TIMEOUT_MS} ms ceiling`);
      }
    } else if (ts.isIdentifier(value) && value.text !== "undefined" && !isComputedConst(value)) {
      report(keyNode, "timeout", `\`${key}: ${value.text}\` cannot be resolved to a number in this file, so the guard cannot tell it is within the ${MAX_TIMEOUT_MS} ms ceiling`);
    }
  };

  walk(sf, (node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && TIMEOUT_KEYS.has(node.name.text)) {
      checkTimeoutValue(node.initializer, node, node.name.text);
    } else if (ts.isShorthandPropertyAssignment(node) && TIMEOUT_KEYS.has(node.name.text)) {
      checkTimeoutValue(node.name, node, node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const args = node.arguments;
      if (name === "setTimeout" || name === "sleep") {
        const first = args[0];
        const delay = name === "sleep" ? first : args.length >= 2 ? args[1] : first !== undefined && !ts.isArrowFunction(first) && !ts.isFunctionExpression(first) && !ts.isIdentifier(first) ? first : undefined;
        if (delay !== undefined) {
          const ms = evalNumber(delay, consts);
          if (ms !== undefined && ms >= MIN_FLAGGED_DELAY_MS) {
            report(delay, "sleep", `\`${name}\` waits ${ms} ms`);
          } else if (ms === undefined && ts.isIdentifier(delay)) {
            report(delay, "sleep", `\`${name}\` waits \`${delay.text}\`, which cannot be resolved to a number in this file`);
          }
        }
      }

      const root = calleeRoot(node);
      const last = args[args.length - 1];
      if (root !== undefined && TEST_CALL_ROOTS.has(root) && args.length >= 2 && last !== undefined) {
        const ms = evalNumber(last, consts);
        if (ms !== undefined && ms > MAX_TIMEOUT_MS) {
          report(last, "timeout", `a trailing ${ms} ms timeout on \`${root}(...)\` is above the ${MAX_TIMEOUT_MS} ms ceiling`);
        }
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "expect") {
        let chain: ts.Node = node;
        while (chain.parent !== undefined && ((ts.isPropertyAccessExpression(chain.parent) && chain.parent.expression === chain) || (ts.isCallExpression(chain.parent) && chain.parent.expression === chain))) {
          chain = chain.parent;
        }
        const measurement = findMeasurement(chain);
        if (measurement !== undefined) {
          report(measurement, "clock-assertion", "an expect asserts on a difference between two clock reads");
        }
        walk(chain, (inner) => {
          const isPropertyName = inner.parent !== undefined && ts.isPropertyAccessExpression(inner.parent) && inner.parent.name === inner;
          if (ts.isIdentifier(inner) && !isPropertyName && measuredVars.has(inner.text)) {
            report(inner, "clock-assertion", `an expect reaches \`${inner.text}\`, a difference between two clock reads`);
          }
        });
      }
    }
  });

  lines.forEach((lineText, index) => {
    if (lineText.includes("SPAWN_TIMEOUT_FLOOR")) {
      found.set(`${index + 1}:spawn-floor`, { file, line: index + 1, rule: "spawn-floor", detail: "mentions SPAWN_TIMEOUT_FLOOR", lineText: lineText.trim() });
    }
  });

  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** Splits violations into those no allowlist entry covers and the entries that covered nothing. */
function applyAllowlist(violations: readonly Violation[], allowlist: readonly AllowEntry[]): { readonly remaining: Violation[]; readonly unused: AllowEntry[] } {
  const used = new Set<AllowEntry>();
  const remaining = violations.filter((violation) => {
    const entry = allowlist.find((candidate) => candidate.file === violation.file && candidate.line.test(violation.lineText));
    if (entry !== undefined) {
      used.add(entry);
    }
    return entry === undefined;
  });
  return { remaining, unused: allowlist.filter((entry) => !used.has(entry)) };
}

/** Every test source under tests/ as a forward-slash path relative to it, the guard itself and dot or node_modules directories left out. */
function listTestSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        found.push(...listTestSources(full));
      }
    } else if (SOURCE_EXTENSION.test(entry.name)) {
      found.push(relative(TESTS_DIR, full).split(sep).join("/"));
    }
  }
  return found.filter((file) => file !== SELF).sort();
}

describe("tests never wait on or assert about the wall clock", () => {
  const sources = listTestSources(TESTS_DIR);

  it("scans the real test tree, so an empty walk cannot pass vacuously", () => {
    expect(sources.length, "the walk of tests/ found too few sources").toBeGreaterThan(50);
    expect(sources, "the walk must reach nested directories").toContain("unit/budgetClock.test.ts");
    expect(sources, "the guard excludes itself").not.toContain(SELF);
  });

  it("no test source has a long delay, a clock assertion, a timeout above the default or the spawn floor", () => {
    const all = sources.flatMap((file) => scanSource(file, readFileSync(join(TESTS_DIR, file), "utf8")));
    const { remaining, unused } = applyAllowlist(all, ALLOWLIST);
    expect(unused, "an allowlist entry that matches no violation is stale; delete it").toEqual([]);
    expect(remaining.map(describeViolation), "timing violations in tests/").toEqual([]);
  });

  it("every allowlist entry names an existing file and carries a one-line reason", () => {
    for (const entry of ALLOWLIST) {
      expect(sources, `allowlist file ${entry.file} does not exist under tests/`).toContain(entry.file);
      expect(entry.reason.trim().length > 0 && !entry.reason.includes("\n"), `allowlist entry for ${entry.file} needs a non-empty one-line reason`).toBe(true);
    }
  });
});

describe("the timing scanner", () => {
  const cases: ReadonlyArray<readonly [string, string, readonly Rule[]]> = [
    ["a three-second sleep", "await new Promise((r) => setTimeout(r, 3000));", ["sleep"]],
    ["a delay at the 100 ms boundary", "setTimeout(r, 100);", ["sleep"]],
    ["a delay just under the boundary", "setTimeout(r, 99);", []],
    ["an arithmetic delay", "setTimeout(r, 2 * 1_000);", ["sleep"]],
    ["a delay held in a same-file constant", "const WAIT = 2 * 1000;\nsetTimeout(r, WAIT);", ["sleep"]],
    ["a short delay held in a constant", "const TICK = 10;\nsetTimeout(r, TICK);", []],
    ["a delay that cannot be resolved", "setTimeout(r, someMs);", ["sleep"]],
    ["a promise-timers delay", "await setTimeout(500);", ["sleep"]],
    ["a bare callback with no delay", "setTimeout(callback);", []],
    ["a sleep helper call", "await sleep(250);", ["sleep"]],
    ["a sleep helper definition", "function sleep(ms: number) { return ms; }", []],
    ["a setInterval that must hang", "setInterval(() => {}, 60000);", []],
    ["a sleep spelled in a comment or a string", "// setTimeout(r, 3000)\nconst s = 'setTimeout(r, 3000)';", []],
    ["a describe timeout over the ceiling", 'describe("x", { timeout: 120_000 }, () => {});', ["timeout"]],
    ["a timeout at the ceiling", 'it("x", { timeout: 30_000 }, () => {});', []],
    ["a timeout one over the ceiling", 'it("x", { timeout: 30_001 }, () => {});', ["timeout"]],
    ["a timeout held in a constant", 'const LONG = 60_000;\nit("x", { timeout: LONG }, () => {});', ["timeout"]],
    ["a timeout whose identifier cannot be resolved", 'it("x", { timeout: imported }, () => {});', ["timeout"]],
    ["a shorthand timeout from a constant", 'const timeout = 90_000;\nit("x", { timeout }, () => {});', ["timeout"]],
    ["a testTimeout key", "vi.setConfig({ testTimeout: 60_000 });", ["timeout"]],
    ["a hook entry's call-expression timeout", "const hook = { type: 'command', timeout: claudeHookTimeoutSeconds(event) };", []],
    ["a hook entry's small literal timeout", "const hook = { type: 'command', timeout: 45 };", []],
    ["a timeout bound to a call in this file", "const timeout = hookSeconds(event);\nconst entry = { timeout };", []],
    ["a timeout parameter", "function install(timeout: number | undefined) { return timeout; }", []],
    ["a trailing it timeout", 'it("x", () => {}, 180_000);', ["timeout"]],
    ["a trailing it timeout at the ceiling", 'it("x", () => {}, 30_000);', []],
    ["a trailing it.each timeout", 'it.each([1])("x", () => {}, 60_000);', ["timeout"]],
    ["a trailing hook timeout", "beforeAll(() => {}, 90_000);", ["timeout"]],
    ["a test whose last argument is its handler", 'it("x", handler);', []],
    ["an elapsed time asserted directly", "const t0 = Date.now();\nexpect(Date.now() - t0).toBeLessThan(5000);", ["clock-assertion"]],
    ["an elapsed time held in a variable", "const s = performance.now();\nconst elapsed = performance.now() - s;\nexpect(elapsed).toBeLessThan(50);", ["clock-assertion"]],
    ["an elapsed time from two captured reads", "const a = Date.now();\nconst b = Date.now();\nexpect(b - a).toBeLessThan(5);", ["clock-assertion"]],
    ["an elapsed time inside a matcher argument", "const t0 = Date.now();\nexpect(1).toBeLessThan(Date.now() - t0);", ["clock-assertion"]],
    ["a measured variable that never reaches an expect", "const t0 = Date.now();\nconst elapsed = Date.now() - t0;\nlog(elapsed);", []],
    ["a timestamp built by fixture arithmetic", "const old = new Date(Date.now() - 86_400_000);\nexpect(old).toBeDefined();", []],
    ["a fixture timestamp held in a variable that reaches an expect", "const old = Date.now() - 60_000;\nexpect(old).toBeGreaterThan(0);", []],
    ["a fixture clock difference inside the actual of an expect", "expect(evaluate(root, Date.now() - 1)).toBe('unverified');", []],
    ["the retired spawn timeout floor", "const x = SPAWN_TIMEOUT_FLOOR_MS;", ["spawn-floor"]],
    ["the retired spawn timeout floor in a comment", "// SPAWN_TIMEOUT_FLOOR_MS", ["spawn-floor"]],
  ];

  it.each(cases)("%s", (_name, source, expected) => {
    expect(scanSource("sample.test.ts", source).map((violation) => violation.rule), `rules reported for: ${source}`).toEqual(expected);
  });

  it("names the file, the line, the rule and the fix, with the line numbered from 1", () => {
    const [violation] = scanSource("unit/sample.test.ts", "const a = 1;\nawait sleep(5000);\n");
    expect(violation, "the sleep must be reported").toBeDefined();
    const message = describeViolation(violation as Violation);
    expect(message, "file and line").toContain("unit/sample.test.ts:2 ");
    expect(message, "rule").toContain("[sleep]");
    expect(message, "fix").toContain("Fix: wait on a condition");
    expect(message, "offending line").toContain("await sleep(5000);");
  });

  it("an allowlist entry covers only its own file and line pattern, and a stale entry is reported", () => {
    const violations = [
      ...scanSource("a.test.ts", "await sleep(5000);"),
      ...scanSource("b.test.ts", "await sleep(5000);"),
    ];
    const covering: AllowEntry = { file: "a.test.ts", line: /sleep\(5000\)/u, reason: "a shim that must hang" };
    const stale: AllowEntry = { file: "a.test.ts", line: /sleep\(9999\)/u, reason: "matches nothing" };
    const { remaining, unused } = applyAllowlist(violations, [covering, stale]);
    expect(remaining.map((violation) => violation.file), "only the other file stays reported").toEqual(["b.test.ts"]);
    expect(unused, "the entry that matched nothing is stale").toEqual([stale]);
  });
});
