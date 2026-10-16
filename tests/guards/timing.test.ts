/** Source-level guard that no test waits on, or asserts about, the wall clock: a fixed delay of 100 ms or more, an elapsed-time assertion, a per-test timeout above the 30 s default in vitest.config.ts, or the retired spawn-timeout floor. All of these pass on a quiet machine and fail on a slow one, and a longer number only moves the failure to the next slower machine. It parses every test source under tests/ with the TypeScript compiler (a dev dependency the comment guard already uses), in-process: it spawns nothing and sets no timeout of its own. The guard file is excluded because its fixtures spell the patterns out. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "guards/timing.test.ts";
const SOURCE_EXTENSION = /\.(ts|mts|cts|mjs|cjs|js)$/u;

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
function evalNumber(node: ts.Node, resolve: Resolver, depth = 0): number | undefined {
  if (depth > 8) {
    return undefined;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalNumber(node.expression, resolve, depth + 1);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = evalNumber(node.operand, resolve, depth + 1);
    return operand === undefined ? undefined : -operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evalNumber(node.left, resolve, depth + 1);
    const right = evalNumber(node.right, resolve, depth + 1);
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
    const initializer = resolve(node);
    return initializer === undefined ? undefined : evalNumber(initializer, resolve, depth + 1);
  }
  return undefined;
}

/** The initializer of the declaration an identifier use resolves to by scope, or `undefined` when that declaration has none (a parameter, a bare `let`, a loop variable) or there is none in the file. */
type Resolver = (identifier: ts.Identifier) => ts.Expression | undefined;

const BLOCK_SCOPES = (node: ts.Node): boolean =>
  ts.isBlock(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node) || ts.isSourceFile(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node);

/** The node a declaration is visible in: a `let`/`const`/`using` in its block (or its loop or catch), a `var` or a parameter in the nearest function or file. */
function scopeOf(declaration: ts.VariableDeclaration | ts.ParameterDeclaration): ts.Node {
  if (ts.isParameter(declaration)) {
    return declaration.parent;
  }
  const blockScoped = ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
  let node: ts.Node = declaration.parent;
  while (!ts.isSourceFile(node) && !(blockScoped ? BLOCK_SCOPES(node) : ts.isFunctionLike(node))) {
    node = node.parent;
  }
  return node;
}

/** Builds the by-scope resolver for one source file: each declared name is bound in the scope that declares it, a use looks outward from itself and takes the first scope that binds the name, so a nested `const t` shadows an outer one and a sibling's `t` is never seen. */
function buildResolver(sf: ts.SourceFile): Resolver {
  const scopes = new Map<ts.Node, Map<string, ts.Expression | undefined>>();
  const bind = (scope: ts.Node, name: string, initializer: ts.Expression | undefined): void => {
    let names = scopes.get(scope);
    if (names === undefined) {
      names = new Map();
      scopes.set(scope, names);
    }
    if (!names.has(name)) {
      names.set(name, initializer);
    }
  };
  const bindPattern = (pattern: ts.BindingName, scope: ts.Node): void => {
    if (ts.isIdentifier(pattern)) {
      bind(scope, pattern.text, undefined);
      return;
    }
    for (const element of pattern.elements) {
      if (ts.isBindingElement(element)) {
        bindPattern(element.name, scope);
      }
    }
  };
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        bind(scopeOf(node), node.name.text, node.initializer);
      } else {
        bindPattern(node.name, scopeOf(node));
      }
    } else if (ts.isParameter(node)) {
      bindPattern(node.name, scopeOf(node));
    }
  });
  return (identifier) => {
    for (let node: ts.Node | undefined = identifier; node !== undefined; node = node.parent) {
      const names = scopes.get(node);
      if (names?.has(identifier.text) === true) {
        return names.get(identifier.text);
      }
    }
    return undefined;
  };
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

/** Names bound to the sleep or timer functions by a simple alias, mapped to the function they stand for: an import under another name (`import { setTimeout as wait }`), `const pause = sleep`, a destructured rename (`const { setTimeout: wait } = timers`), and `promisify(setTimeout)`, followed through chains of them. */
function collectDelayAliases(sf: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const isDelayName = (name: string): boolean => name === "setTimeout" || name === "sleep";
  const kindOf = (expression: ts.Expression | undefined): string | undefined => {
    if (expression === undefined) {
      return undefined;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return kindOf(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      return aliases.get(expression.text) ?? (isDelayName(expression.text) ? expression.text : undefined);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return isDelayName(expression.name.text) ? expression.name.text : undefined;
    }
    if (ts.isCallExpression(expression) && calleeName(expression) === "promisify") {
      return kindOf(expression.arguments[0]);
    }
    return undefined;
  };
  for (let pass = 0; pass < 4; pass++) {
    const before = aliases.size;
    walk(sf, (node) => {
      if (ts.isImportSpecifier(node) && node.propertyName !== undefined && isDelayName(node.propertyName.text)) {
        aliases.set(node.name.text, node.propertyName.text);
      } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName !== undefined && (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName)) && isDelayName(node.propertyName.text)) {
        aliases.set(node.name.text, node.propertyName.text);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const kind = kindOf(node.initializer);
        if (kind !== undefined && node.name.text !== kind) {
          aliases.set(node.name.text, kind);
        }
      }
    });
    if (aliases.size === before) {
      break;
    }
  }
  return aliases;
}

/** The identifier at the root of `it`, `it.skip`, `it.each(table)` and the like. */
function calleeRoot(call: ts.CallExpression): string | undefined {
  let node: ts.Expression = call.expression;
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

/** Every violation in one test source. Recognised shapes: `setTimeout(fn, ms)`, `setTimeout(ms)` and `sleep(ms)` (also under an alias: an import rename, `const pause = sleep`, a destructured rename, `promisify(setTimeout)`) with a delay of 100 ms or more, and an `Atomics.wait` or `Atomics.waitAsync` whose fourth argument, its timeout, is 100 ms or more or unresolvable (one with no timeout is a barrier its releaser ends); a clock difference between two clock reads (`Date.now() - startedAt`, `end - start`) written inside an `expect(...)` chain or held in a variable that reaches one; `timeout`, `testTimeout` and `hookTimeout` object keys and a trailing numeric argument of `it`/`test`/`describe`/a hook above 30 s (also one computed in place, parenthesised or cast, bound to a name, or chosen by a conditional, read through its call arguments and branches as a `timeout:` value is, and likewise a `setTimeout` or `sleep` delay of 100 ms or more); any text mention of the spawn timeout floor. Numbers resolve through literals, arithmetic and `const`s by scope (the nearest enclosing declaration, so a shadowing or sibling-scope constant is never mistaken for another); a `timeout:` key whose bare-identifier value cannot be resolved is reported as unresolved, while a call-expression value (a hook entry's `timeout: claudeHookTimeoutSeconds(...)`), an identifier bound to one by scope, and a parameter type annotation (`timeout: number`) are not vitest options and are left alone unless a numeric argument of the call is itself over the ceiling (`Math.max(120_000, x)`), which is reported. A clock minus a literal or a constant (`Date.now() - 86_400_000`) is fixture arithmetic that builds an old timestamp, not a measurement. */
function scanSource(file: string, text: string): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const found = new Map<string, Violation>();
  const report = (node: ts.Node, rule: Rule, detail: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.set(`${line}:${rule}`, { file, line, rule, detail, lineText: (lines[line - 1] ?? "").trim() });
  };

  const resolve = buildResolver(sf);
  const declarations: ts.VariableDeclaration[] = [];
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      declarations.push(node);
    }
  });
  const delayAliases = collectDelayAliases(sf);

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

  /** The call an expression is, or an identifier is bound to by scope: a computed value the guard cannot evaluate, but whose literal arguments it can read. */
  const peel = (value: ts.Expression): ts.Expression | undefined => {
    let node: ts.Expression | undefined = value;
    for (let hops = 0; node !== undefined && hops < 8; hops++) {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        node = node.expression;
      } else if (ts.isIdentifier(node)) {
        node = resolve(node);
      } else {
        break;
      }
    }
    return node;
  };
  const callOf = (value: ts.Expression): ts.CallExpression | undefined => {
    const node = peel(value);
    return node !== undefined && ts.isCallExpression(node) ? node : undefined;
  };
  const largestOf = (...parts: Array<number | undefined>): number | undefined =>
    parts.reduce<number | undefined>((best, part) => (part !== undefined && (best === undefined || part > best) ? part : best), undefined);
  /** The largest number any argument of `call` is built from, looking into nested calls, conditionals and operands (`Math.max(120_000, x)`, `Math.min(clamp(60 * 1000), x)`, `Math.max(a, ci ? 60_000 : 1)`), or `undefined` when none evaluates. */
  const largestArgument = (call: ts.CallExpression, depth = 0): number | undefined => largestOf(...call.arguments.map((arg) => largestComputed(arg, depth + 1)));
  /** The largest number a value the evaluator cannot read is built from: the arguments of the call it is (in place, parenthesised, cast, or bound to a name), the larger branch of a conditional, the larger side of `||`, `??` and `&&`, or the larger operand of `+ - * /` (so a literal operand alone over the ceiling is reported, whatever the other side is), or `undefined` when none evaluates. */
  const largestComputed = (value: ts.Expression, depth = 0): number | undefined => {
    const node = peel(value);
    if (node === undefined || depth >= 8) {
      return undefined;
    }
    if (ts.isCallExpression(node)) {
      return largestArgument(node, depth);
    }
    if (ts.isConditionalExpression(node)) {
      return largestOf(largestComputed(node.whenTrue, depth + 1), largestComputed(node.whenFalse, depth + 1));
    }
    if (ts.isBinaryExpression(node) && OPERAND_OPERATORS.has(node.operatorToken.kind)) {
      return evalNumber(node, resolve) ?? largestOf(largestComputed(node.left, depth + 1), largestComputed(node.right, depth + 1));
    }
    return evalNumber(node, resolve);
  };
  const checkTimeoutValue = (value: ts.Expression, keyNode: ts.Node, key: string): void => {
    const ms = evalNumber(value, resolve);
    if (ms !== undefined) {
      if (ms > MAX_TIMEOUT_MS) {
        report(keyNode, "timeout", `\`${key}\` of ${ms} ms is above the ${MAX_TIMEOUT_MS} ms ceiling`);
      }
      return;
    }
    const call = callOf(value);
    const peeled = peel(value);
    const combined = peeled !== undefined && ts.isBinaryExpression(peeled) && OPERAND_OPERATORS.has(peeled.operatorToken.kind);
    if (call !== undefined || combined || (peeled !== undefined && ts.isConditionalExpression(peeled))) {
      const largest = largestComputed(value);
      if (largest !== undefined && largest > MAX_TIMEOUT_MS) {
        const how = call !== undefined ? "computed by a call with a" : combined ? "built from an expression with a" : "chosen by a conditional with a";
        const part = call !== undefined ? "argument" : combined ? "operand" : "branch";
        report(keyNode, "timeout", `\`${key}\` is ${how} ${largest} ms ${part}, above the ${MAX_TIMEOUT_MS} ms ceiling`);
      }
    } else if (ts.isIdentifier(value) && value.text !== "undefined") {
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
      const name = ts.isIdentifier(node.expression) ? (delayAliases.get(node.expression.text) ?? calleeName(node)) : calleeName(node);
      const args = node.arguments;
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Atomics" && (callee.name.text === "wait" || callee.name.text === "waitAsync")) {
        // The fourth argument is the timeout; without one the wait is a barrier that its releaser ends, not a sleep.
        const limit = args[3];
        if (limit !== undefined) {
          const ms = evalNumber(limit, resolve);
          if (ms === undefined || ms >= MIN_FLAGGED_DELAY_MS) {
            report(limit, "sleep", `\`Atomics.${callee.name.text}\` waits ${ms === undefined ? `\`${limit.getText(sf)}\`, which cannot be resolved to a number in this file` : `${ms} ms`}`);
          }
        }
      }
      if (name === "setTimeout" || name === "sleep") {
        const first = args[0];
        const delay = name === "sleep" ? first : args.length >= 2 ? args[1] : first !== undefined && !ts.isArrowFunction(first) && !ts.isFunctionExpression(first) && !ts.isIdentifier(first) ? first : undefined;
        if (delay !== undefined) {
          const ms = evalNumber(delay, resolve);
          if (ms !== undefined && ms >= MIN_FLAGGED_DELAY_MS) {
            report(delay, "sleep", `\`${name}\` waits ${ms} ms`);
          } else if (ms === undefined && ts.isIdentifier(delay)) {
            report(delay, "sleep", `\`${name}\` waits \`${delay.text}\`, which cannot be resolved to a number in this file`);
          } else if (ms === undefined) {
            const largest = largestComputed(delay);
            if (largest !== undefined && largest >= MIN_FLAGGED_DELAY_MS) {
              report(delay, "sleep", `\`${name}\` waits a computed value with a ${largest} ms operand`);
            }
          }
        }
      }

      const root = calleeRoot(node);
      const last = args[args.length - 1];
      if (root !== undefined && TEST_CALL_ROOTS.has(root) && args.length >= 2 && last !== undefined) {
        const ms = evalNumber(last, resolve);
        const largest = ms === undefined ? largestComputed(last) : undefined;
        if (ms !== undefined && ms > MAX_TIMEOUT_MS) {
          report(last, "timeout", `a trailing ${ms} ms timeout on \`${root}(...)\` is above the ${MAX_TIMEOUT_MS} ms ceiling`);
        } else if (largest !== undefined && largest > MAX_TIMEOUT_MS) {
          report(last, "timeout", `a trailing timeout computed from a ${largest} ms operand on \`${root}(...)\` is above the ${MAX_TIMEOUT_MS} ms ceiling`);
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

/** The tokens a trailing argument can be made of and still evaluate to a number: literals, constants, `+ - * /` (a slash never reaches the token list, see `opaqueSlashEnd`) and parentheses. */
const ARITHMETIC_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.CloseParenToken,
]);

/** Tokens that, straight after a leading name, make the expression something other than that bare name (a call, a member access, a comparison, a conditional, an arrow): the number evaluator reads none of them. */
const NON_OPERAND_FOLLOW = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.DotToken,
  ts.SyntaxKind.QuestionDotToken,
  ts.SyntaxKind.OpenBracketToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.EqualsGreaterThanToken,
]);
/** Tokens that cannot start an expression the number evaluator reads (it reads a number, a parenthesis, a minus sign or a name). */
const NON_NUMERIC_START = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.OpenBraceToken,
  ts.SyntaxKind.OpenBracketToken,
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
/** The binary operators whose operands a computed timeout or delay is read from: the logical ones (either side may be the value) and arithmetic. */
const OPERAND_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
]);
/** Tokens that close a declaration's initializer: the number is then the whole of it. */
const INITIALIZER_END = new Set<ts.SyntaxKind>([ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBraceToken]);
/** What a word in the scan means, so one map lookup per word answers every question the scan asks of it. */
const ROLE_DELAY = 1;
const ROLE_KEY = 2;
const ROLE_TYPED = 3;
const ROLE_DECLARATION = 4;
const ROLE_ROOT = 5;
const WORD_ROLES = new Map<string, number>([
  ["setTimeout", ROLE_DELAY],
  ["sleep", ROLE_DELAY],
  ["as", ROLE_TYPED],
  ["satisfies", ROLE_TYPED],
  ["const", ROLE_DECLARATION],
  ["let", ROLE_DECLARATION],
  ["var", ROLE_DECLARATION],
  ["using", ROLE_DECLARATION],
  ...[...TIMEOUT_KEYS].map((key): [string, number] => [key, ROLE_KEY]),
  ...[...TEST_CALL_ROOTS].map((root): [string, number] => [root, ROLE_ROOT]),
]);
/** Every keyword's text, kept out of a skipped slash span: a word like `return` or `typeof` makes the next slash open a regular expression, and a role word is one the scan acts on. */
const SPAN_FORBIDDEN_WORDS = new Set<string>(WORD_ROLES.keys());
for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind++) {
  const text = ts.tokenToString(kind);
  if (text !== undefined) {
    SPAN_FORBIDDEN_WORDS.add(text);
  }
}
/** The ASCII characters a skipped slash span may hold: 1 is a letter, digit, `_` or `$`, 2 is a space, tab, `.`, `+`, `*`, `^`, `|`, `%`, `&` or `~`; everything else (quotes, backtick, brackets, `,` `;` `:` `=` `-` `<` `>` `!` `?`, backslash, `#`, `@`, line breaks) is 0. */
const SPAN_CHARS = new Uint8Array(128);
for (let code = 0; code < 128; code++) {
  const char = String.fromCharCode(code);
  SPAN_CHARS[code] = /[A-Za-z0-9_$]/u.test(char) ? 1 : " \t.+*^|%&~".includes(char) ? 2 : 0;
}
const CHAR_SLASH = 47;
const CHAR_STAR = 42;
const CHAR_EQUALS = 61;
const CHAR_BACKSLASH = 92;

const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_UPPER_U_LOWER = 117;
/** The characters no expression starts with, so a division operator followed by one is a syntax error: `)` `]` `}` `,` `;` `:` `?` `>` `^` `|` `%` `&`, and a `.` that no digit follows. */
const NO_OPERAND_START = new Set([41, 93, 125, 44, 59, 58, 63, 62, 94, 124, 37, 38]);

// The lexer's one grammar-dependent choice is a slash (division, or the start of a regular expression; a template `}` is told by the bracket stack), so the pass never guesses it from the token before: a slash is read as a regular expression only when the division reading cannot lex or parse (the answer is then about a source that parses, the one `false` is proven for), which two grammar-free witnesses show, an operand-less start (the first character after the slash cannot start an expression) or a backslash reached through plain characters (no quote, backtick, slash or `#` that could open a string, comment or private name, no `}` that does not close a `{` the walk itself opened, which could close a template substitution whatever bracket is innermost) that the scanner rejects outside a string; every other slash goes to `opaqueSlashEnd` or answers `true`.
/** Whether a `/` at `slash` cannot be a division operator in a source that lexes and parses, so it opens a regular expression. */
function divisionIsImpossible(text: string, slash: number): boolean {
  let at = slash + 1;
  while (text.charCodeAt(at) === CHAR_SPACE || text.charCodeAt(at) === CHAR_TAB) {
    at++;
  }
  const first = text.charCodeAt(at);
  if (NO_OPERAND_START.has(first)) {
    return true;
  }
  if (first === 46) {
    const digit = text.charCodeAt(at + 1);
    if (!(digit >= 48 && digit <= 57)) {
      return true;
    }
  }
  let braces = 0;
  for (; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === CHAR_BACKSLASH) {
      return text.charCodeAt(at + 1) !== CHAR_UPPER_U_LOWER;
    }
    if (code === 39 || code === 34 || code === 96 || code === CHAR_SLASH || code === 35 || code === 10 || code === 13 || code >= 128) {
      return false;
    }
    if (code === 123) {
      braces++;
    } else if (code === 125) {
      if (braces === 0) {
        return false;
      }
      braces--;
    }
  }
  return false;
}

// A slash that is not provably a regular expression is skipped only when both readings leave the pass in the same state: the span to the next slash on its line holds only the characters of SPAN_CHARS (so no token the pass acts on, no bracket, comma, colon, `=`, `-` or quote), no keyword or role word (so no word can make the closing slash open a regex), and ends in a word or number (so the closing slash divides in the division reading), and the closing slash is not run into an identifier character, `=`, `/` or `*`, unless that is a flag word of regular expression flag letters that is no keyword and is followed by `)` `;` `,` `]` or `}` (so both readings resume lexing at the same character, the flag word being one more word that ends the span); a regex literal and a closing slash are both a non-word, which resets the same three flags, so the span becomes one `Unknown` token, a kind no set the readers consult holds, and the two readers that would take it for a non-number (`trailingArgumentIsNumeric`, `delayMayBeReported`) answer `true` on it.
/** The letters a regular expression flag can be. */
const FLAG_LETTERS = "dgimsuvy";
/** The characters a flag word may be followed by (`)` `;` `,` `]` `}`), which end the span in both readings without a call, member access or assignment on the word. */
const FLAG_FOLLOWERS = new Set([41, 59, 44, 93, 125]);
/** The index just past the closing slash of the span that starts at the slash at `slash`, or -1 when this slash is one the pass cannot prove harmless. */
function opaqueSlashEnd(text: string, slash: number): number {
  let wordStart = -1;
  let at = slash + 1;
  for (; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === CHAR_SLASH) {
      break;
    }
    const kind = code < 128 ? (SPAN_CHARS[code] as number) : 0;
    if (kind === 1) {
      if (wordStart < 0) {
        wordStart = at;
      }
      continue;
    }
    if (kind === 0) {
      return -1;
    }
    if (wordStart >= 0) {
      if (SPAN_FORBIDDEN_WORDS.has(text.slice(wordStart, at))) {
        return -1;
      }
      wordStart = -1;
    }
  }
  if (at >= text.length || wordStart < 0 || SPAN_FORBIDDEN_WORDS.has(text.slice(wordStart, at))) {
    return -1;
  }
  let flagEnd = at + 1;
  while (FLAG_LETTERS.includes(text.charAt(flagEnd)) && flagEnd < text.length) {
    flagEnd++;
  }
  if (flagEnd > at + 1) {
    const after = text.charCodeAt(flagEnd);
    return SPAN_FORBIDDEN_WORDS.has(text.slice(at + 1, flagEnd)) || !FLAG_FOLLOWERS.has(after) ? -1 : flagEnd;
  }
  const next = text.charCodeAt(at + 1);
  if (next >= 128 || next === CHAR_SLASH || next === CHAR_STAR || next === CHAR_EQUALS || next === CHAR_BACKSLASH || SPAN_CHARS[next] === 1) {
    return -1;
  }
  return at + 1;
}

/** Tokens that end a bare-word type after `as` or `satisfies`: the type has no comma inside. */
const TYPE_END = new Set<ts.SyntaxKind>([ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken]);
/** The words that open a variable declaration, so a name annotated right after one is a declaration that may carry a number. */
const DECLARATION_WORDS = new Set(["const", "let", "var", "using"]);
/** Words that continue an expression after a number, so a name following one on a new line is not a new statement. */
const OPERATOR_WORDS = new Set(["as", "satisfies", "in", "instanceof", "of"]);

interface Bracket {
  readonly kind: ts.SyntaxKind;
  /** Whether the callee in front of a `(` may have a test-call root; `true` whenever that cannot be told. */
  readonly rootish: boolean;
  /** Token index where the current argument starts, and where the one before it started. */
  argStart: number;
  prevArgStart: number;
  /** Token indexes of each `as` or `satisfies` at this bracket's own level or inside parentheses nested in it: a type that is more than one bare word may hold commas, which would misplace the argument boundaries. */
  readonly asTypes: number[];
  /** Whether a `const`, `let` or `var` has been seen at this bracket's own level, so a name after a comma may be one more declaration in that list. */
  declares: boolean;
}

/** The token kinds the scan below tests on every token, read once: a property lookup on the compiler's enum object costs far more than the comparison it feeds. */
const KIND_CloseBraceToken = ts.SyntaxKind.CloseBraceToken;
const KIND_CloseBracketToken = ts.SyntaxKind.CloseBracketToken;
const KIND_CloseParenToken = ts.SyntaxKind.CloseParenToken;
const KIND_ColonToken = ts.SyntaxKind.ColonToken;
const KIND_CommaToken = ts.SyntaxKind.CommaToken;
const KIND_DotToken = ts.SyntaxKind.DotToken;
const KIND_EndOfFileToken = ts.SyntaxKind.EndOfFileToken;
const KIND_EqualsGreaterThanToken = ts.SyntaxKind.EqualsGreaterThanToken;
const KIND_EqualsToken = ts.SyntaxKind.EqualsToken;
const KIND_ExclamationToken = ts.SyntaxKind.ExclamationToken;
const KIND_FirstKeyword = ts.SyntaxKind.FirstKeyword;
const KIND_FirstReservedWord = ts.SyntaxKind.FirstReservedWord;
const KIND_GreaterThanToken = ts.SyntaxKind.GreaterThanToken;
const KIND_Identifier = ts.SyntaxKind.Identifier;
const KIND_LastKeyword = ts.SyntaxKind.LastKeyword;
const KIND_LastReservedWord = ts.SyntaxKind.LastReservedWord;
const KIND_MinusToken = ts.SyntaxKind.MinusToken;
const KIND_NoSubstitutionTemplateLiteral = ts.SyntaxKind.NoSubstitutionTemplateLiteral;
const KIND_NumericLiteral = ts.SyntaxKind.NumericLiteral;
const KIND_OpenBraceToken = ts.SyntaxKind.OpenBraceToken;
const KIND_OpenBracketToken = ts.SyntaxKind.OpenBracketToken;
const KIND_OpenParenToken = ts.SyntaxKind.OpenParenToken;
const KIND_QuestionDotToken = ts.SyntaxKind.QuestionDotToken;
const KIND_SlashEqualsToken = ts.SyntaxKind.SlashEqualsToken;
const KIND_SlashToken = ts.SyntaxKind.SlashToken;
const KIND_StringLiteral = ts.SyntaxKind.StringLiteral;
const KIND_TemplateHead = ts.SyntaxKind.TemplateHead;
const KIND_Unknown = ts.SyntaxKind.Unknown;
const KIND_LessThanToken = ts.SyntaxKind.LessThanToken;
const KIND_QuestionToken = ts.SyntaxKind.QuestionToken;
const KIND_DotDotDotToken = ts.SyntaxKind.DotDotDotToken;
const KIND_SemicolonToken = ts.SyntaxKind.SemicolonToken;
const KIND_TemplateTail = ts.SyntaxKind.TemplateTail;

function isWord(kind: ts.SyntaxKind): boolean {
  return kind === KIND_Identifier || (kind >= KIND_FirstKeyword && kind <= KIND_LastKeyword);
}

/** A word that may be an identifier: every word but the reserved ones (`true`, `new`, `this`, ...), which are never one. */
function isNameWord(kind: ts.SyntaxKind): boolean {
  return isWord(kind) && !(kind >= KIND_FirstReservedWord && kind <= KIND_LastReservedWord);
}

/** Whether `scanSource` could report something in `text`, answered from one token pass (no syntax tree, a fraction of a parse's cost): `false` only when every rule's trigger is absent, `true` for anything it cannot rule out, so a `false` proves `scanSource` returns nothing for a source that parses. Triggers: the spawn-floor name in the text; a `setTimeout` or `sleep` word; a `timeout`, `testTimeout` or `hookTimeout` key (word or string, read decoded) in a `{` whose value is not a literal or a single-literal constant at or under the ceiling, nor an expression the number evaluator cannot read; a clock read subtracted from a clock read (`Date.now() - startedAt` and its `performance` and variable forms); and a call whose callee may root at a test function (`it`, `describe`, a hook, reached through `.`, `(...)` or anything unreadable) whose last argument is built only from numbers, `+ - * /`, parentheses and names a declaration in the file may give a number, or is a call, a conditional or a `||`, `??` or `&&` expression (not a function, object, array or string) holding a number above the ceiling or a name some declaration gives a value; and a `setTimeout` or `sleep` delay that is a call, a conditional or such a logical expression holding a number of 100 or more or such a name. A scanner error or unbalanced bracket means the pass misread the text, so it answers `true` there too. */
function mayHaveTimingViolation(text: string): boolean {
  if (text.includes("SPAWN_TIMEOUT_FLOOR") || text.includes("Atomics")) {
    return true;
  }
  let misread = false;
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, text, () => {
    misread = true;
  });
  const kinds: ts.SyntaxKind[] = [];
  const words: string[] = [];
  const breaks: boolean[] = [];
  const stack: Bracket[] = [];
  const timeoutKeys: number[] = [];
  const delayCalls: number[] = [];
  const minuses: number[] = [];
  const assignments = new Map<string, number[]>();
  const annotated = new Map<string, number[]>();
  const declaringSites = new Set<number>();
  const declaringColons = new Set<number>();
  const suspect = new Set<string>();
  const trailingWords: string[] = [];
  const trailingValues: number[] = [];
  let rootish = false;
  let endsExpression = false;
  let afterDot = false;
  let topDeclares = false;
  const isComplexType = (at: number): boolean => {
    const after = kinds[at + 2];
    return !(isWord(kinds[at + 1] ?? KIND_Unknown) && (after === undefined || TYPE_END.has(after)));
  };
  /** Whether the argument in tokens `start` to `stop` is a function (an arrow, `function`, `async`), an object, an array, a string or a template, none of which can hold a ceiling-breaking number. */
  const isFunctionOrLiteral = (start: number, stop: number): boolean => {
    const first = kinds[start] as ts.SyntaxKind;
    if (first === KIND_OpenBraceToken || first === KIND_OpenBracketToken || first === KIND_StringLiteral || first === KIND_TemplateHead || first === KIND_NoSubstitutionTemplateLiteral || words[start] === "function" || words[start] === "async") {
      return true;
    }
    let depth = 0;
    for (let index = start; index < stop; index++) {
      const kind = kinds[index] as ts.SyntaxKind;
      if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
        depth++;
      } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
        depth--;
      } else if (depth === 0 && kind === KIND_EqualsGreaterThanToken) {
        return true;
      }
    }
    return false;
  };
  const trailingArgumentIsNumeric = (open: Bracket, close: number): boolean => {
    let start = open.argStart;
    let stop = close;
    if (start >= stop && open.prevArgStart >= 0) {
      start = open.prevArgStart;
      stop = open.argStart - 1;
    }
    let hasNumber = false;
    const names: string[] = [];
    for (let index = start; index < stop; index++) {
      const kind = kinds[index] as ts.SyntaxKind;
      if (kind === KIND_Unknown) {
        return true;
      }
      if (isWord(kind)) {
        names.push(words[index] as string);
      } else if (ARITHMETIC_TOKENS.has(kind)) {
        hasNumber ||= kind === KIND_NumericLiteral;
      } else {
        if (!isFunctionOrLiteral(start, stop)) {
          trailingValues.push(start);
        }
        return false;
      }
    }
    if (hasNumber) {
      return true;
    }
    trailingWords.push(...names);
    return false;
  };

  for (let kind = scanner.scan(); kind !== KIND_EndOfFileToken; kind = scanner.scan()) {
    const previous = kinds[kinds.length - 1];
    const precedingBreak = scanner.hasPrecedingLineBreak();
    if (kind === KIND_SlashToken || kind === KIND_SlashEqualsToken) {
      const start = scanner.getTokenStart();
      if (divisionIsImpossible(text, start)) {
        kind = scanner.reScanSlashToken();
      } else {
        const end = opaqueSlashEnd(text, start);
        if (end < 0) {
          return true;
        }
        scanner.resetTokenState(end);
        kind = KIND_Unknown;
      }
    } else if (kind === KIND_CloseBraceToken && stack[stack.length - 1]?.kind === KIND_TemplateHead) {
      kind = scanner.reScanTemplateToken(false);
    }
    const wordy = isWord(kind);
    const word = wordy || kind === KIND_StringLiteral || kind === KIND_NumericLiteral ? scanner.getTokenValue() : "";
    const role = wordy || kind === KIND_StringLiteral ? WORD_ROLES.get(word) : undefined;
    const index = kinds.length;
    if (role === ROLE_KEY) {
      if (stack[stack.length - 1]?.kind === KIND_OpenBraceToken && previous !== KIND_DotToken && previous !== KIND_QuestionDotToken && !(previous !== undefined && isWord(previous) && DECLARATION_WORDS.has(words[index - 1] as string))) {
        timeoutKeys.push(index);
      }
    } else if (role !== undefined && wordy) {
      if (role === ROLE_DELAY) {
        delayCalls.push(index);
      }
      if (role === ROLE_TYPED) {
        for (let depth = stack.length - 1; depth >= 0 && (stack[depth] as Bracket).kind === KIND_OpenParenToken; depth--) {
          (stack[depth] as Bracket).asTypes.push(index);
        }
      } else if (role === ROLE_DECLARATION) {
        const level = stack[stack.length - 1];
        if (level === undefined) {
          topDeclares = true;
        } else {
          level.declares = true;
        }
      }
    }
    if (previous !== undefined && isWord(previous)) {
      const name = words[index - 1] as string;
      if (kind === KIND_EqualsToken) {
        const opener = kinds[index - 2];
        if (opener !== undefined && isWord(opener) && DECLARATION_WORDS.has(words[index - 2] as string)) {
          declaringSites.add(index);
        }
        const at = assignments.get(name);
        if (at === undefined) {
          assignments.set(name, [index]);
        } else {
          at.push(index);
        }
      } else if (kind === KIND_ColonToken) {
        const before = kinds[index - 2];
        const directlyDeclared = before !== undefined && isWord(before) && DECLARATION_WORDS.has(words[index - 2] as string);
        if (before !== undefined && (before === KIND_CommaToken ? (stack[stack.length - 1]?.declares ?? topDeclares) : directlyDeclared)) {
          if (directlyDeclared) {
            declaringColons.add(index);
          }
          const at = annotated.get(name);
          if (at === undefined) {
            annotated.set(name, [index]);
          } else {
            at.push(index);
          }
        }
      }
    }
    if ((kind === KIND_ExclamationToken || kind === KIND_QuestionToken) && previous !== undefined && isWord(previous)) {
      suspect.add(words[index - 1] as string);
    }
    if (kind === KIND_MinusToken) {
      minuses.push(index);
    }
    kinds.push(kind);
    words.push(word);
    breaks.push(precedingBreak);

    let nextRootish = false;
    let nextEnds = false;
    let nextAfterDot = false;
    switch (kind) {
      case KIND_OpenParenToken:
        stack.push({ kind, rootish: endsExpression && rootish, argStart: kinds.length, prevArgStart: -1, asTypes: [], declares: false });
        break;
      case KIND_OpenBracketToken:
      case KIND_OpenBraceToken:
      case KIND_TemplateHead:
        stack.push({ kind, rootish: false, argStart: -1, prevArgStart: -1, asTypes: [], declares: false });
        break;
      case KIND_CommaToken: {
        const top = stack[stack.length - 1];
        if (top?.kind === KIND_OpenParenToken) {
          top.prevArgStart = top.argStart;
          top.argStart = kinds.length;
        }
        break;
      }
      case KIND_CloseParenToken:
      case KIND_CloseBracketToken:
      case KIND_CloseBraceToken:
      case KIND_TemplateTail: {
        const open = stack.pop();
        const expected = kind === KIND_CloseParenToken ? KIND_OpenParenToken : kind === KIND_CloseBracketToken ? KIND_OpenBracketToken : kind === KIND_CloseBraceToken ? KIND_OpenBraceToken : KIND_TemplateHead;
        if (open?.kind !== expected) {
          return true;
        }
        if (kind === KIND_CloseParenToken) {
          if (open.rootish && (open.asTypes.some(isComplexType) || trailingArgumentIsNumeric(open, kinds.length - 1))) {
            return true;
          }
          nextRootish = open.rootish;
          nextEnds = true;
        } else if (kind !== KIND_CloseBraceToken) {
          nextRootish = true;
          nextEnds = true;
        }
        break;
      }
      case KIND_DotToken:
        nextRootish = rootish;
        nextAfterDot = true;
        break;
      case KIND_QuestionDotToken:
        nextRootish = rootish;
        nextEnds = true;
        nextAfterDot = true;
        break;
      case KIND_NoSubstitutionTemplateLiteral:
      case KIND_GreaterThanToken:
      case KIND_ExclamationToken:
        nextRootish = true;
        nextEnds = true;
        break;
      default:
        if (isWord(kind)) {
          nextRootish = afterDot ? rootish : role === ROLE_ROOT;
          nextEnds = true;
        }
    }
    rootish = nextRootish;
    endsExpression = nextEnds;
    afterDot = nextAfterDot;
  }
  if (misread || stack.length > 0) {
    return true;
  }

  /** Every `=` that gives a name an initializer: the plain ones, and the one after the type of an annotated declaration (`const name: Type = ...`), found by walking the type to the first `=` outside brackets before a `;`. */
  const initializers = new Map<string, number[]>();
  for (const [name, at] of assignments) {
    initializers.set(name, [...at]);
  }
  for (const [name, colons] of annotated) {
    for (const colon of colons) {
      let depth = 0;
      for (let at = colon + 1; at < kinds.length; at++) {
        const kind = kinds[at] as ts.SyntaxKind;
        if (kind === KIND_LessThanToken || kind === KIND_ExclamationToken || kind === KIND_QuestionToken || kind === KIND_QuestionDotToken) {
          suspect.add(name);
        } else if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
          depth++;
        } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
          if (--depth < 0) {
            break;
          }
        } else if (depth === 0 && kind === KIND_SemicolonToken) {
          break;
        } else if (depth === 0 && kind === KIND_EqualsToken) {
          if (declaringColons.has(colon)) {
            declaringSites.add(at);
          }
          const known = initializers.get(name);
          if (known === undefined) {
            initializers.set(name, [at]);
          } else {
            known.push(at);
          }
          break;
        }
      }
    }
  }

  /** The value of `name` when its one declaration in the file gives it a bare number, otherwise undefined. */
  const literalConstant = (name: string): number | undefined => {
    const at = initializers.get(name);
    const equals = at?.[0];
    if (at?.length !== 1 || equals === undefined || annotated.has(name) || kinds[equals + 1] !== KIND_NumericLiteral) {
      return undefined;
    }
    const after = kinds[equals + 2];
    const closed = after === undefined || INITIALIZER_END.has(after) || (isWord(after) && breaks[equals + 2] === true && !OPERATOR_WORDS.has(words[equals + 2] as string));
    return closed ? Number(words[equals + 1]) : undefined;
  };
  /** Whether the initializer after the `=` at token `equals` is a single call (`f(...)`, `g.f(...)`), which the guard leaves alone as computed at run time. */
  const isCallInitializer = (equals: number): boolean => {
    let last = equals + 1;
    if (!isNameWord(kinds[last] ?? KIND_Unknown)) {
      return false;
    }
    while (kinds[last + 1] === KIND_DotToken && isWord(kinds[last + 2] ?? KIND_Unknown)) {
      last += 2;
    }
    if (kinds[last + 1] !== KIND_OpenParenToken) {
      return false;
    }
    let depth = 0;
    let close = last + 1;
    for (; close < kinds.length; close++) {
      const kind = kinds[close] as ts.SyntaxKind;
      if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
        depth++;
      } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
        if (--depth === 0) {
          break;
        }
      }
    }
    const after = kinds[close + 1];
    return close < kinds.length && (after === undefined || INITIALIZER_END.has(after) || (isWord(after) && breaks[close + 1] === true && !OPERATOR_WORDS.has(words[close + 1] as string)));
  };
  /** Whether the expression starting at token `start` may be a number the evaluator reads: it starts with a number, a parenthesis, a minus sign, or a name that is not made into a call, member or comparison. */
  const mayEvaluateToNumber = (start: number): boolean => {
    const first = kinds[start];
    if (first === undefined) {
      return true;
    }
    if (isNameWord(first)) {
      const after = kinds[start + 1];
      return after === undefined || !NON_OPERAND_FOLLOW.has(after);
    }
    return !NON_NUMERIC_START.has(first) && !isWord(first);
  };
  /** Whether the expression starting at token `start` holds a call and, anywhere in it, a number above the ceiling, a number next to arithmetic, or a name some declaration in the file gives a value: the shapes the scanner reads a ceiling-breaking argument from (`Math.max(120_000, x)`, `Math.min(LIMIT, x)`). It may run on into the next statement, which only makes it say yes more often. */
  const callCarriesNumbers = (start: number, floor = MAX_TIMEOUT_MS, conditional = false): boolean => {
    let depth = 0;
    let called = false;
    let carries = false;
    let numbers = false;
    let arithmetic = false;
    for (let at = start; at < kinds.length; at++) {
      const kind = kinds[at] as ts.SyntaxKind;
      if (kind === KIND_Unknown) {
        return true;
      }
      if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
        called ||= depth === 0 && kind === KIND_OpenParenToken;
        depth++;
      } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
        if (--depth < 0) {
          break;
        }
      } else if (depth === 0 && (kind === KIND_CommaToken || kind === KIND_SemicolonToken)) {
        break;
      } else if (conditional && depth === 0 && (kind === KIND_QuestionToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
        called = true;
      } else if (kind === KIND_NumericLiteral) {
        numbers = true;
        carries ||= Number(words[at]) > floor;
      } else if (isWord(kind) && (initializers.has(words[at] as string) || annotated.has(words[at] as string))) {
        carries = true;
      } else if (kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.AsteriskToken || kind === KIND_SlashToken || kind === KIND_MinusToken) {
        arithmetic = true;
      }
    }
    return called && (carries || (numbers && arithmetic));
  };
  /** Whether a bare name given as a `timeout` value is certainly fine: a constant with one bare number at or under the ceiling, a name every declaration of which holds something that is no number and one of them a single call, or `undefined` when nothing in the file redefines it. Only an `=` that opens a `const`, `let` or `var` declarator counts (the one shape the scanner reads an initializer from): a parameter or destructuring default, a property or later plain assignment, or a later declarator in a list leaves the name unsettled. */
  const nameIsSettled = (name: string): boolean => {
    if (suspect.has(name)) {
      return false;
    }
    if (name === "undefined" && !initializers.has(name) && !annotated.has(name)) {
      return true;
    }
    const declarations = initializers.get(name) ?? [];
    if (declarations.some((equals) => !declaringSites.has(equals))) {
      return false;
    }
    const value = literalConstant(name);
    return (value !== undefined && value <= MAX_TIMEOUT_MS) || (declarations.every((equals) => !mayEvaluateToNumber(equals + 1) && !callCarriesNumbers(equals + 1)) && declarations.some(isCallInitializer));
  };
  /** Whether the `setTimeout` or `sleep` word at token `name` could be a call the guard reports: a call whose delay is not a bare number under the flagged minimum and not something the number evaluator cannot read. A mention that is no call is no trigger, and a call it cannot take apart (type arguments, a spread, a type assertion inside) counts. */
  const delayMayBeReported = (name: number): boolean => {
    const opener = kinds[name + 1];
    if (opener !== KIND_OpenParenToken) {
      return true; // a mention that is no call may be an alias (const pause = sleep, setTimeout as wait), whose calls the scanner follows
    }
    const args: Array<readonly [number, number]> = [];
    let depth = 0;
    let start = name + 2;
    for (let at = name + 1; at < kinds.length; at++) {
      const kind = kinds[at] as ts.SyntaxKind;
      if (kind === KIND_Unknown || kind === KIND_LessThanToken || kind === KIND_GreaterThanToken || kind === KIND_DotDotDotToken || (isWord(kind) && (words[at] === "as" || words[at] === "satisfies"))) {
        return true;
      }
      if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
        depth++;
      } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
        if (--depth === 0) {
          if (at > start) {
            args.push([start, at]);
          }
          break;
        }
      } else if (kind === KIND_CommaToken && depth === 1) {
        args.push([start, at]);
        start = at + 1;
      }
    }
    if (depth !== 0) {
      return true;
    }
    const first = args[0];
    let delay: readonly [number, number] | undefined;
    if (words[name] === "sleep") {
      delay = first;
    } else if (args.length >= 2) {
      delay = args[1];
    } else if (first !== undefined) {
      return !(first[1] - first[0] === 1 && isNameWord(kinds[first[0]] as ts.SyntaxKind));
    }
    if (delay === undefined) {
      return false;
    }
    if (delay[1] - delay[0] === 1 && kinds[delay[0]] === KIND_NumericLiteral) {
      return !(Number(words[delay[0]]) < MIN_FLAGGED_DELAY_MS);
    }
    return mayEvaluateToNumber(delay[0]) || callCarriesNumbers(delay[0], MIN_FLAGGED_DELAY_MS - 1, true);
  };
  /** Whether a `timeout` key whose value starts at token `start` could be reported: a number above the ceiling, or a bare name that does not settle. */
  const valueMayBeReported = (start: number): boolean => {
    const first = kinds[start];
    if (first === undefined) {
      return true;
    }
    if (!mayEvaluateToNumber(start)) {
      return callCarriesNumbers(start, MAX_TIMEOUT_MS, true);
    }
    const after = kinds[start + 1];
    if (after === KIND_CommaToken || after === KIND_CloseBraceToken) {
      if (first === KIND_NumericLiteral) {
        return !(Number(words[start]) <= MAX_TIMEOUT_MS);
      }
      if (isNameWord(first)) {
        return !nameIsSettled(words[start] as string);
      }
    }
    return true;
  };
  for (const key of timeoutKeys) {
    const after = kinds[key + 1];
    if (after === KIND_ColonToken) {
      if (valueMayBeReported(key + 2)) {
        return true;
      }
    } else if (after === undefined || after === KIND_CommaToken || after === KIND_CloseBraceToken || after === KIND_EqualsToken) {
      if (after === KIND_EqualsToken || !nameIsSettled(words[key] as string)) {
        return true;
      }
    } else if (after !== KIND_OpenParenToken) {
      return true;
    }
  }

  if (delayCalls.some(delayMayBeReported)) {
    return true;
  }

  const clockVariables = new Set<string>(suspect);
  const isClockOwner = (index: number): boolean => {
    const owner = words[index];
    return kinds[index] !== undefined && isWord(kinds[index] as ts.SyntaxKind) && (owner === "Date" || owner === "performance");
  };
  for (const [name, at] of initializers) {
    for (const equals of at) {
      if (isClockOwner(equals + 1) && (kinds[equals + 2] === KIND_DotToken || kinds[equals + 2] === KIND_QuestionDotToken) && words[equals + 3] === "now") {
        clockVariables.add(name);
      }
    }
  }
  const endsClockOperand = (last: number): boolean => {
    const kind = kinds[last];
    if (kind === KIND_CloseParenToken) {
      const before = kinds[last - 2];
      return kinds[last - 1] === KIND_OpenParenToken && (words[last - 2] === "now" || before === KIND_QuestionDotToken || before === KIND_GreaterThanToken);
    }
    return kind !== undefined && isWord(kind) && clockVariables.has(words[last] as string);
  };
  const startsClockOperand = (first: number): boolean => {
    const kind = kinds[first];
    return kind !== undefined && isWord(kind) && (isClockOwner(first) || clockVariables.has(words[first] as string));
  };
  if (minuses.some((minus) => endsClockOperand(minus - 1) && startsClockOperand(minus + 1))) {
    return true;
  }

  return trailingValues.some((start) => callCarriesNumbers(start, MAX_TIMEOUT_MS, true)) || trailingWords.some((name) => suspect.has(name) || initializers.get(name)?.some((equals) => mayEvaluateToNumber(equals + 1) || callCarriesNumbers(equals + 1, MAX_TIMEOUT_MS, true)) === true);
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
  let scanned: Array<{ file: string; text: string; keep: boolean }> | undefined;
  /** Each source read once with the prefilter's verdict, shared by the tests below so the tree is walked by the prefilter a single time. */
  const scanTree = (): Array<{ file: string; text: string; keep: boolean }> => {
    scanned ??= sources.map((file) => {
      const text = readFileSync(join(TESTS_DIR, file), "utf8");
      return { file, text, keep: mayHaveTimingViolation(text) };
    });
    return scanned;
  };

  it("scans the real test tree, so an empty walk cannot pass vacuously", () => {
    expect(sources.length, "the walk of tests/ found too few sources").toBeGreaterThan(50);
    expect(sources, "the walk must reach nested directories").toContain("unit/budgetClock.test.ts");
    expect(sources, "the guard excludes itself").not.toContain(SELF);
  });

  it("no test source has a long delay, a clock assertion, a timeout above the default or the spawn floor", () => {
    const all = scanTree().flatMap(({ file, text, keep }) => (keep ? scanSource(file, text) : []));
    const { remaining, unused } = applyAllowlist(all, ALLOWLIST);
    expect(unused, "an allowlist entry that matches no violation is stale; delete it").toEqual([]);
    expect(remaining.map(describeViolation), "timing violations in tests/").toEqual([]);
  });

  it("the prefilter lets most of the real test tree skip the parse", () => {
    const kept = scanTree().filter(({ keep }) => keep).map(({ file }) => file);
    expect(kept.length, `kept for a full parse: ${kept.join(", ")}`).toBeLessThan(sources.length / 2);
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
    ["a timeout computed by Math.max with a literal over the ceiling", 'const t = Math.max(120_000, x);\nit("x", { timeout: t }, () => {});', ["timeout"]],
    ["a timeout computed by Math.min with a literal over the ceiling, written in place", 'it("x", { timeout: Math.min(120_000, x) }, () => {});', ["timeout"]],
    ["a computed timeout whose argument is a constant over the ceiling", 'const LIMIT = 90_000;\nconst t = Math.max(LIMIT, x);\nit("x", { timeout: t }, () => {});', ["timeout"]],
    ["a computed timeout whose argument is arithmetic over the ceiling", 'const t = Math.max(60 * 1000, x);\nit("x", { timeout: t }, () => {});', ["timeout"]],
    ["a computed timeout with only small literal arguments", 'const t = Math.max(1_000, x);\nit("x", { timeout: t }, () => {});', []],
    ["a timeout key chosen by a conditional with a branch over the ceiling", 'const slow = true;\nit("x", { timeout: slow ? 120_000 : 5_000 }, () => {});', ["timeout"]],
    ["a timeout key chosen by a conditional with branches at the ceiling", 'it("x", { timeout: ci ? 30_000 : 5_000 }, () => {});', []],
    ["a timeout key computed in place by Math.max with a literal over the ceiling", 'it("x", { timeout: Math.max(a, 90_000) }, () => {});', ["timeout"]],
    ["a timeout key computed in place by Math.max with a literal at the ceiling", 'it("x", { timeout: Math.max(a, 30_000) }, () => {});', []],
    ["a timeout key that is a parenthesised, cast conditional over the ceiling", 'it("x", { timeout: (ci ? 1_000 : 60_000) as number }, () => {});', ["timeout"]],
    ["a timeout key that is a conditional with a computed branch over the ceiling", 'it("x", { testTimeout: ci ? 1_000 : Math.max(a, 60_000) }, () => {});', ["timeout"]],
    ["a timeout key held in a name bound to a conditional over the ceiling", 'const t = ci ? 60_000 : 1_000;\nit("x", { timeout: t }, () => {});', ["timeout"]],
    ["a timeout key held in a name bound to a conditional under the ceiling", 'const t = ci ? 2_000 : 1_000;\nit("x", { timeout: t }, () => {});', []],
    ["a trailing timeout computed with a literal over the ceiling", 'const t = Math.max(120_000, x);\nit("x", () => {}, t);', ["timeout"]],
    ["a trailing timeout computed in place with a literal over the ceiling", 'it("x", () => {}, Math.max(a, 60_000));', ["timeout"]],
    ["a trailing timeout computed in place with a literal at the ceiling", 'it("x", () => {}, Math.max(a, 30_000));', []],
    ["a trailing timeout computed in place and cast", 'it("x", () => {}, (Math.max(a, 60_000)) as number);', ["timeout"]],
    ["a timeout key falling back to a literal over the ceiling through ||", 'it("x", { timeout: Number(process.env.X) || 60_000 }, () => {});', ["timeout"]],
    ["a timeout key falling back to a literal at the ceiling through ||", 'it("x", { timeout: Number(process.env.X) || 30_000 }, () => {});', []],
    ["a timeout key falling back to a literal over the ceiling through ??", 'it("x", { timeout: a ?? 90_000 }, () => {});', ["timeout"]],
    ["a timeout key falling back to a literal at the ceiling through ??", 'it("x", { timeout: a ?? 30_000 }, () => {});', []],
    ["a timeout key gated to a literal over the ceiling through &&", 'it("x", { timeout: ci && 60_000 }, () => {});', ["timeout"]],
    ["a timeout key scaled from a name by a literal over the ceiling", 'it("x", { timeout: n * 60_000 }, () => {});', ["timeout"]],
    ["a timeout key scaled from a name by a literal under the ceiling", 'it("x", { timeout: n * 1_000 }, () => {});', []],
    ["a timeout key offset from a name by a literal over the ceiling", 'it("x", { timeout: base + 60_000 }, () => {});', ["timeout"]],
    ["a timeout key reduced from a name by a literal over the ceiling", 'it("x", { timeout: base - 60_000 }, () => {});', ["timeout"]],
    ["a timeout key built on an unresolved name with only small literals", 'it("x", { timeout: base + 1_000 }, () => {});', []],
    ["a timeout key computed by Math.max over a conditional with a branch over the ceiling", 'it("x", { timeout: Math.max(a, ci ? 60_000 : 1) }, () => {});', ["timeout"]],
    ["a timeout key computed by Math.max over a conditional with branches at the ceiling", 'it("x", { timeout: Math.max(a, ci ? 30_000 : 1) }, () => {});', []],
    ["a trailing timeout falling back to a literal over the ceiling through ??", 'it("x", () => {}, a ?? 60_000);', ["timeout"]],
    ["a trailing timeout falling back to a literal at the ceiling through ??", 'it("x", () => {}, a ?? 30_000);', []],
    ["a trailing timeout scaled from a name by a literal over the ceiling", 'it("x", () => {}, n * 60_000);', ["timeout"]],
    ["a sleep delay falling back to a flagged literal through ||", "await sleep(a || 5_000);", ["sleep"]],
    ["a sleep delay falling back to a literal under the flagged minimum through ||", "await sleep(a || 50);", []],
    ["a trailing timeout computed in place and cast, under the ceiling", 'it("x", () => {}, (Math.max(a, 1_000)) as number);', []],
    ["a trailing timeout computed by a nested call over the ceiling", 'it("x", () => {}, Math.min(clamp(60 * 1000), a));', ["timeout"]],
    ["a trailing timeout that is a conditional with a literal branch over the ceiling", 'it("x", () => {}, ci ? 60_000 : 1_000);', ["timeout"]],
    ["a trailing timeout that is a conditional with literal branches under the ceiling", 'it("x", () => {}, ci ? 1_000 : 2_000);', []],
    ["a trailing timeout that is a conditional with a computed branch over the ceiling", 'it("x", () => {}, ci ? 1_000 : Math.max(a, 60_000));', ["timeout"]],
    ["a trailing timeout held in a name bound to a conditional over the ceiling", 'const t = ci ? 60_000 : 1_000;\nit("x", () => {}, t);', ["timeout"]],
    ["a trailing timeout computed in place on a hook", "beforeAll(() => {}, Math.max(a, 90_000));", ["timeout"]],
    ["a setTimeout delay computed in place over the flagged minimum", "setTimeout(r, Math.max(a, 5_000));", ["sleep"]],
    ["a setTimeout delay computed in place under the flagged minimum", "setTimeout(r, Math.max(a, 50));", []],
    ["a setTimeout delay computed in place at the flagged minimum", "setTimeout(r, Math.max(a, 100));", ["sleep"]],
    ["a promise-timers delay computed in place", "await setTimeout(Math.max(a, 5_000));", ["sleep"]],
    ["a sleep delay computed in place over the flagged minimum", "await sleep(Math.max(a, 5_000));", ["sleep"]],
    ["a sleep delay computed in place and cast", "await sleep((Math.max(a, 5_000)) as number);", ["sleep"]],
    ["a sleep delay computed in place under the flagged minimum", "await sleep(Math.max(a, 50));", []],
    ["a sleep delay that is a conditional with a branch over the flagged minimum", "await sleep(ci ? 5_000 : 10);", ["sleep"]],
    ["a sleep delay that is a conditional with branches under the flagged minimum", "await sleep(ci ? 50 : 10);", []],
    ["an aliased sleep delay computed in place", "const pause = sleep;\nawait pause(Math.max(a, 5_000));", ["sleep"]],
    ["a shadowing constant over the ceiling declared in an inner scope", 'const t = 10;\ndescribe("a", () => {\n  const t = 120_000;\n  it("b", { timeout: t }, () => {});\n});', ["timeout"]],
    ["a shadowing small constant in an inner scope over an outer one above the ceiling", 'const t = 120_000;\ndescribe("a", () => {\n  const t = 10;\n  it("b", { timeout: t }, () => {});\n});', []],
    ["a same-named constant above the ceiling in a sibling scope", 'describe("a", () => {\n  const t = 120_000;\n});\ndescribe("b", () => {\n  const t = 10;\n  it("c", { timeout: t }, () => {});\n});', []],
    ["an Atomics.wait with a timeout over the flagged minimum", "Atomics.wait(slots, 1, 0, 5000);", ["sleep"]],
    ["an Atomics.waitAsync with a timeout over the flagged minimum", "await Atomics.waitAsync(slots, 1, 0, 5000).value;", ["sleep"]],
    ["an Atomics.wait with an unresolvable timeout", "Atomics.wait(slots, 1, 0, Infinity);", ["sleep"]],
    ["an Atomics.wait with a short timeout", "Atomics.wait(slots, 1, 0, 50);", []],
    ["an Atomics.wait with no timeout, a barrier its releaser ends", "Atomics.wait(slots, 1, 0);", []],
    ["a sleep reached through a plain alias", "const pause = sleep;\nawait pause(5000);", ["sleep"]],
    ["a sleep reached through a chain of aliases", "const a = sleep;\nconst b = a;\nawait b(5000);", ["sleep"]],
    ["a short delay reached through an alias", "const pause = sleep;\nawait pause(50);", []],
    ["a promise-timers delay imported under another name", 'import { setTimeout as wait } from "node:timers/promises";\nawait wait(5000);', ["sleep"]],
    ["a promisified setTimeout", "const wait = promisify(setTimeout);\nawait wait(5000);", ["sleep"]],
    ["a destructured rename of setTimeout", "const { setTimeout: wait } = timersPromises;\nawait wait(5000);", ["sleep"]],
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

  it.each(cases.filter(([, , expected]) => expected.length > 0))("the prefilter keeps the source of: %s", (_name, source) => {
    expect(mayHaveTimingViolation(source), `a source the scanner reports must reach it: ${source}`).toBe(true);
  });

  it.each([
    ["a trailing timeout computed in place", 'it("x", () => {}, Math.max(a, 60_000));', "a trailing timeout computed from a 60000 ms operand on `it(...)` is above the 30000 ms ceiling"],
    ["a trailing timeout that is a conditional", 'it("x", () => {}, ci ? 1_000 : 60_000);', "a trailing timeout computed from a 60000 ms operand on `it(...)` is above the 30000 ms ceiling"],
    ["a sleep delay computed in place", "await sleep(Math.max(a, 5_000));", "`sleep` waits a computed value with a 5000 ms operand"],
    ["a timeout key that is a conditional", 'it("x", { timeout: ci ? 1_000 : 60_000 }, () => {});', "`timeout` is chosen by a conditional with a 60000 ms branch, above the 30000 ms ceiling"],
    ["a timeout key computed in place", 'it("x", { timeout: Math.max(a, 90_000) }, () => {});', "`timeout` is computed by a call with a 90000 ms argument, above the 30000 ms ceiling"],
    ["a timeout key falling back through ??", 'it("x", { timeout: a ?? 90_000 }, () => {});', "`timeout` is built from an expression with a 90000 ms operand, above the 30000 ms ceiling"],
    ["a timeout key falling back through || after a call", 'it("x", { timeout: Number(process.env.X) || 60_000 }, () => {});', "`timeout` is built from an expression with a 60000 ms operand, above the 30000 ms ceiling"],
    ["a trailing timeout falling back through ??", 'it("x", () => {}, a ?? 60_000);', "a trailing timeout computed from a 60000 ms operand on `it(...)` is above the 30000 ms ceiling"],
    ["a sleep delay falling back through ||", "await sleep(a || 5_000);", "`sleep` waits a computed value with a 5000 ms operand"],
  ])("reports %s with its message", (_name, source, detail) => {
    expect(scanSource("sample.test.ts", source).map((violation) => violation.detail)).toEqual([detail]);
  });

  /** Each row's last column is the prefilter's verdict: `true` for every source the scanner reports and for the clean ones it cannot rule out, `false` for the clean ones it skips. */
  const prefilterCases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["a type assertion around a trailing timeout", "it('x', fn, (40000 as Map<a, b>));", true],
    ["a numeric key above the ceiling spelled as a string", "const o = { 'timeout': 40000 };", true],
    ["a timeout held in a constant declared after its use", "const o = { timeout: BIG }; const BIG = 40000;", true],
    ["a timeout held in an annotated constant", "const BIG: number = 40000; const o = { timeout: BIG };", true],
    ["a timeout held in the second declarator of a list", "let k = 1, BIG: number = 40000; const o = { timeout: BIG };", true],
    ["a shorthand timeout from a number constant", "const timeout = 40000; const o = { timeout };", true],
    ["a shorthand timeout shadowed in a block by a call", "const timeout = 99999; { const timeout = compute(); f({ timeout }); }", true],
    ["a timeout over the ceiling as a product", "const o = { timeout: 2 * 20000 };", true],
    ["a timeout held in a parenthesised number", "const o = { timeout: (40000) };", true],
    ["a delay whose type arguments hide the call", "setTimeout<void>(r, 500);", true],
    ["a timeout key falling back to a literal over the ceiling through ||", "const o = { timeout: Number(x) || 60000 };", true],
    ["a timeout key falling back to a literal over the ceiling through ??", "const o = { timeout: a ?? 90000 };", true],
    ["a timeout key falling back to a literal at the ceiling through ??", "const o = { timeout: a ?? 30000 };", false],
    ["a timeout key gated to a literal over the ceiling through &&", "const o = { timeout: ci && 60000 };", true],
    ["a timeout key scaled by a literal over the ceiling", "const o = { timeout: n * 60000 };", true],
    ["a timeout key computed by Math.max over a conditional with a branch over the ceiling", "const o = { timeout: Math.max(a, ci ? 60000 : 1) };", true],
    ["a trailing timeout falling back to a literal over the ceiling through ??", "it('x', fn, a ?? 60000);", true],
    ["a trailing timeout falling back to a literal at the ceiling through ??", "it('x', fn, a ?? 30000);", false],
    ["a sleep delay falling back to a flagged literal through ||", "sleep(a || 5000);", true],
    ["a sleep delay falling back to a literal under the flagged minimum through ||", "sleep(a || 50);", false],
    ["a delay passed through optional call", "setTimeout?.(r, 500);", true],
    ["a delay held in a constant declared after its use", "setTimeout(r, X); const X = 500;", true],
    ["a delay that is a sum of numbers", "setTimeout(r, 50 + 60);", true],
    ["a clock read held in an annotated variable", "const c2: number = Date.now(); const d2 = Date.now() - c2; expect(d2).toBe(1);", true],
    ["a clock read minus a variable that is no clock read", "const x2 = 1; expect(Date?.now() - x2).toBe(1);", false],
    ["a trailing timeout held in a constant", "const T = 3 * 10000, U = T; it('x', fn, U);", true],
    ["a trailing timeout assigned later", "let T: number; T = 40000; it('x', fn, T);", true],
    ["a timeout under the ceiling in a constant", "const small = 5000; const o = { timeout: small, hookTimeout: small };", false],
    ["a timeout bound to a call", "const timeout = compute(); const o = { timeout };", false],
    ["a timeout bound to a member call", "const timeout = a.b.compute(1, 2); const o = { timeout };", false],
    ["a timeout key marked optional in a type, kept because the scan cannot tell it from a key given a value", "type T = { timeout?: number };", true],
    ["a destructured timeout parameter, kept because the scan cannot tell it from a key", "function f({ timeout }: { timeout: number }) {}", true],
    ["a timeout key given undefined", "const o = { timeout: undefined };", false],
    ["a small literal timeout", "const o = { 'timeout': 5 };", false],
    ["a delay under the flagged minimum", "setTimeout(r, 99);", false],
    ["a bare callback with no delay", "setTimeout(fn);", false],
    ["a mention of the delay word that is no call, which may be an alias the scanner follows", "const s = setTimeout; vi.spyOn(globalThis, 'setTimeout');", true],
    ["a definition of the sleep helper, kept because the scan cannot tell it from a call", "function sleep(ms: number) { return ms; }", true],
    ["a clock read that never meets a subtraction", "const c = Date.now(); log(c);", false],
    ["a fixture timestamp that no clock read minus another", "const c6 = Date.now() - 86_400_000; expect(c6).toBe(1);", false],
    ["a computed timeout with only small literal arguments, which the scanner leaves alone", "const t = Math.max(1_000, x); it('x', { timeout: t }, f);", false],
    ["a trailing timeout computed in place with only small literal arguments", "it('x', fn, Math.max(a, 1_000));", false],
    ["a trailing timeout that is a conditional of small literals", "it('x', fn, ci ? 1_000 : 2_000);", false],
    ["a trailing timeout that is a handler with a computed value in its body", "it('x', (a, b) => { run(Math.max(a, 60_000)); });", false],
    ["a setTimeout delay computed in place under the flagged minimum", "setTimeout(r, Math.max(a, 50));", false],
    ["a sleep delay that is a conditional of small literals", "sleep(ci ? 50 : 10);", false],
    ["a timeout key that is a conditional of small literals", "it('x', { timeout: ci ? 1_000 : 2_000 }, f);", false],
    ["a timeout key computed in place with only small literal arguments", "it('x', { timeout: Math.max(a, 1_000) }, f);", false],
    ["a timeout key that is a conditional with a literal over the ceiling", "it('x', { timeout: ci ? 60_000 : 1 }, f);", true],
    ["a timeout key that is a conditional with a computed branch over the ceiling", "it('x', { timeout: ci ? 1 : Math.max(a, 60_000) }, f);", true],
    ["a timeout key computed in place over the ceiling", "it('x', { timeout: Math.max(a, 90_000) }, f);", true],
    ["a trailing timeout computed in place over the ceiling", "it('x', fn, Math.max(a, 60_000));", true],
    ["a trailing timeout that is a conditional with a literal over the ceiling", "it('x', fn, ci ? 60_000 : 1);", true],
    ["a trailing timeout held in a name bound to a conditional", "const t = ci ? 60_000 : 1; it('x', fn, t);", true],
    ["a setTimeout delay computed in place over the flagged minimum", "setTimeout(r, Math.max(a, 5_000));", true],
    ["a sleep delay that is a conditional with a branch over the flagged minimum", "sleep(ci ? 5_000 : 10);", true],
    ["an Atomics.wait barrier with no timeout, kept because the scanner decides it", "Atomics.wait(slots, 1, generation);", true],
    ["a sleep alias, kept so its calls are followed", "const pause = sleep;", true],
    ["a source with no timing word at all", "export const answer = 6 * 7;\nit('x', () => { expect(answer).toBe(42); });", false],
    ["a regex holding a quote after an if head", "if (x) /'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex holding a quote after a function body", "function f() {}\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex holding a quote after a while head", "while (a) /x'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex holding a double quote after a for head", 'for (;;) /x"/.test(s); foo({ timeout: 99999 }); // it"s', true],
    ["a regex holding a backtick after an if head", "if (a) /`/.test(s); foo({ timeout: 99999 }); // it`s", true],
    ["a regex holding a brace after an if head", "if (a) /{/.test(s); foo({ timeout: 99999 }); /}/", true],
    ["a division after a property named like a regex keyword", "x.return / 2; foo({timeout: 99999}); y = z / w;", true],
    ["a negated regex holding a quote", "const n = !/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a division after a property named like a regex keyword and nothing else, kept because the scan cannot tell it from a regex", "x.return / 2; const y = z / w;", true],
    ["a division after a group, left to the parse", "const half = (a + b) / 2;", true],
    ["a division after a non-null assertion, left to the parse", "const half = a! / 2;", true],
    ["a parameter default given as a shorthand timeout", "const helper = (timeout = 5000) => run({ timeout });", true],
    ["a parameter default that is a call, given as a shorthand timeout", "function f(timeout = getMs()) { return run({ timeout }); }", true],
    ["a property assigned a number while the parameter is the timeout", "function make(timeout: number) { cfg.timeout = 5000; return start({ timeout }); }", true],
    ["a name declared bare and assigned later", "let T;\nT = 5000;\nrun({ timeout: T });", true],
    ["a destructuring default given as a shorthand timeout", "const { timeout = 5000 } = options; run({ timeout });", true],
    ["a declarator later in a list, kept because only the first is read as a declaration", "const a = 1, timeout = 5000; run({ timeout });", true],
    ["a timeout from a let declaration of a small number", "let small = 5000; run({ timeout: small });", false],
    ["a division after an as type with type arguments", "const h = v as Big<number> / 2; foo({ timeout: 99999 }); const z = w / 3;", true],
    ["a division after a satisfies type with type arguments", "const h = v satisfies X<Y> / 2; foo({ timeout: 99999 }); const z = w / 3;", true],
    ["a division after a call with type arguments", "const h = f<number> / 2; foo({ timeout: 99999 }); const z = w / 3;", true],
    ["a regex after a bare let", "let x\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a let with a type", "let x: number\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a let with an array type", "let x: number[]\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a type alias", "type A = string\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after an ambient declaration", "declare const q: Q\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a break", "for (;;) { break\n}\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a continue", "for (;;) { continue\n}\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after a debugger statement", "debugger\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after an export default", "export default /'/.source; foo({ timeout: 99999 }); // it's", true],
    ["a regex after an increment", "let i = 0; ++/'/.lastIndex; foo({ timeout: 99999 }); // it's", true],
    ["a regex after extends", "class A extends /'/.constructor {} foo({ timeout: 99999 }); // it's", true],
    ["a regex after a bare import", "import \"m\"\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a regex after an instanceof operand", "const b = a instanceof\n/'/.constructor; foo({ timeout: 99999 }); // it's", true],
    ["a regex after in", "const b = 'a' in\n/'/; foo({ timeout: 99999 }); // it's", true],
    ["a regex after case", "switch (a) { case\n/'/.source: break; } foo({ timeout: 99999 }); // it's", true],
    ["a regex after typeof", "const t = typeof\n/'/; foo({ timeout: 99999 }); // it's", true],
    ["a regex after else", "if (a) b(); else\n/'/.test(s); foo({ timeout: 99999 }); // it's", true],
    ["a number held under a generic function type annotation", "const T: <X = {}>() => void = 99999 as any; it('x', () => {}, T);", true],
    ["a number held in a block name shadowed in the next block", "{ const T: <X = {}>() => number = 99999 as any; run({ timeout: T }); }\n{ const T = make(); use(T); }", true],
    ["a definite assignment name given a number", "let T! = 99999; run({ timeout: T });", true],
    ["a timeout key marked optional", "run({ timeout?: 99999 });", true],
    ["a timeout key marked definite", "run({ timeout!: 99999 });", true],
    ["a regex with flags and no quote, decided without the parse", "const a = 1;\nexpect(m).toMatch(/remember|check/u);\nconst b = 2;", false],
    ["a chain of divisions, kept because the scan cannot tell it from a regex", "const share = used / total / count;", true],
    ["a division in parentheses inside a template substitution, then an escape past the substitution's close", "const s = `${(a / 2)}\\n/ ${'`'}`; foo({ timeout: 99999 }); const z = `)}`;", true],
    ["a division in brackets inside a template substitution, then an escape past the substitution's close", "const s = `${[a / 2]}\\n/ ${'`'}`; foo({ timeout: 99999 }); const z = `]}`;", true],
    ["a division in braces inside a template substitution, then an escape past the substitution's close", "const s = `${{ k: a / 2 }.k}\\t/ ${'`'}`; foo({ timeout: 99999 }); const z = `}}`;", true],
    ["a division inside a template substitution hiding a delay call", "const s = `${(a / 2)}\\n/ ${'`'}`; setTimeout(f, 5000); const z = `)}`;", true],
  ];

  it.each(prefilterCases)("the prefilter agrees with the scanner on: %s", (_name, source, flagged) => {
    const reported = scanSource("sample.test.ts", source).length > 0;
    if (reported) {
      expect(mayHaveTimingViolation(source), `the scanner reports this, so the prefilter must keep it: ${source}`).toBe(true);
    }
    expect(mayHaveTimingViolation(source), `the prefilter verdict for: ${source}`).toBe(flagged);
  });

  it("lists test sources of every module flavour, .cjs and .cts included", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-timing-list-"));
    try {
      const names = ["a.ts", "b.mts", "c.cts", "d.js", "e.mjs", "f.cjs"];
      names.forEach((name) => writeFileSync(join(dir, name), ""));
      writeFileSync(join(dir, "g.json"), "");
      expect(listTestSources(dir).map((path) => path.split("/").pop()), "sources listed").toEqual(names);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
