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

/** Words that start a regular expression, not a division, when a `/` follows them. */
const REGEX_AFTER = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ReturnKeyword,
  ts.SyntaxKind.TypeOfKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.NewKeyword,
  ts.SyntaxKind.DeleteKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.ThrowKeyword,
  ts.SyntaxKind.CaseKeyword,
  ts.SyntaxKind.DoKeyword,
  ts.SyntaxKind.ElseKeyword,
  ts.SyntaxKind.YieldKeyword,
  ts.SyntaxKind.AwaitKeyword,
]);
/** Tokens after which a `/` divides; after any other token, and after the words above, it starts a regular expression (a misread there is caught by the bracket and scanner-error checks). */
const DIVISION_AFTER = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.PrivateIdentifier,
]);
/** The tokens a trailing argument can be made of and still evaluate to a number: literals, constants, `+ - * /` and parentheses. */
const ARITHMETIC_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
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

/** Whether `scanSource` could report something in `text`, answered from one token pass (no syntax tree, a fraction of a parse's cost): `false` only when every rule's trigger is absent, `true` for anything it cannot rule out, so a `false` proves `scanSource` returns nothing for a source that parses. Triggers: the spawn-floor name in the text; a `setTimeout` or `sleep` word; a `timeout`, `testTimeout` or `hookTimeout` key (word or string, read decoded) in a `{` whose value is not a literal or a single-literal constant at or under the ceiling, nor an expression the number evaluator cannot read; a clock read subtracted from a clock read (`Date.now() - startedAt` and its `performance` and variable forms); and a call whose callee may root at a test function (`it`, `describe`, a hook, reached through `.`, `(...)` or anything unreadable) whose last argument is built only from numbers, `+ - * /`, parentheses and names a declaration in the file may give a number. A scanner error or unbalanced bracket means the pass misread the text, so it answers `true` there too. */
function mayHaveTimingViolation(text: string): boolean {
  if (text.includes("SPAWN_TIMEOUT_FLOOR")) {
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
  const trailingWords: string[] = [];
  let rootish = false;
  let endsExpression = false;
  let afterDot = false;
  let topDeclares = false;
  const isComplexType = (at: number): boolean => {
    const after = kinds[at + 2];
    return !(isWord(kinds[at + 1] ?? KIND_Unknown) && (after === undefined || TYPE_END.has(after)));
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
      if (isWord(kind)) {
        names.push(words[index] as string);
      } else if (ARITHMETIC_TOKENS.has(kind)) {
        hasNumber ||= kind === KIND_NumericLiteral;
      } else {
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
    if ((kind === KIND_SlashToken || kind === KIND_SlashEqualsToken) && (previous === undefined || REGEX_AFTER.has(previous) || !(isWord(previous) || DIVISION_AFTER.has(previous)))) {
      kind = scanner.reScanSlashToken();
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
        const at = assignments.get(name);
        if (at === undefined) {
          assignments.set(name, [index]);
        } else {
          at.push(index);
        }
      } else if (kind === KIND_ColonToken) {
        const before = kinds[index - 2];
        if (before !== undefined && (before === KIND_CommaToken ? (stack[stack.length - 1]?.declares ?? topDeclares) : isWord(before) && DECLARATION_WORDS.has(words[index - 2] as string))) {
          const at = annotated.get(name);
          if (at === undefined) {
            annotated.set(name, [index]);
          } else {
            at.push(index);
          }
        }
      }
    }
    if (kind === KIND_MinusToken) {
      minuses.push(index);
    }
    kinds.push(kind);
    words.push(word);
    breaks.push(scanner.hasPrecedingLineBreak());

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
        if (kind === KIND_OpenParenToken || kind === KIND_OpenBracketToken || kind === KIND_OpenBraceToken || kind === KIND_TemplateHead) {
          depth++;
        } else if (kind === KIND_CloseParenToken || kind === KIND_CloseBracketToken || kind === KIND_CloseBraceToken || kind === KIND_TemplateTail) {
          if (--depth < 0) {
            break;
          }
        } else if (depth === 0 && kind === KIND_SemicolonToken) {
          break;
        } else if (depth === 0 && kind === KIND_EqualsToken) {
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
  /** Whether a bare name given as a `timeout` value is certainly fine: a constant with one bare number at or under the ceiling, a name every declaration of which holds something that is no number and one of them a single call, or `undefined` when nothing in the file redefines it. */
  const nameIsSettled = (name: string): boolean => {
    if (name === "undefined" && !initializers.has(name) && !annotated.has(name)) {
      return true;
    }
    const value = literalConstant(name);
    const declarations = initializers.get(name) ?? [];
    return (value !== undefined && value <= MAX_TIMEOUT_MS) || (declarations.every((equals) => !mayEvaluateToNumber(equals + 1)) && declarations.some(isCallInitializer));
  };
  /** Whether the `setTimeout` or `sleep` word at token `name` could be a call the guard reports: a call whose delay is not a bare number under the flagged minimum and not something the number evaluator cannot read. A mention that is no call is no trigger, and a call it cannot take apart (type arguments, a spread, a type assertion inside) counts. */
  const delayMayBeReported = (name: number): boolean => {
    const opener = kinds[name + 1];
    if (opener !== KIND_OpenParenToken) {
      return opener === KIND_LessThanToken || opener === KIND_QuestionDotToken;
    }
    const args: Array<readonly [number, number]> = [];
    let depth = 0;
    let start = name + 2;
    for (let at = name + 1; at < kinds.length; at++) {
      const kind = kinds[at] as ts.SyntaxKind;
      if (kind === KIND_LessThanToken || kind === KIND_GreaterThanToken || kind === KIND_DotDotDotToken || (isWord(kind) && (words[at] === "as" || words[at] === "satisfies"))) {
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
    return mayEvaluateToNumber(delay[0]);
  };
  /** Whether a `timeout` key whose value starts at token `start` could be reported: a number above the ceiling, or a bare name that does not settle. */
  const valueMayBeReported = (start: number): boolean => {
    const first = kinds[start];
    if (first === undefined) {
      return true;
    }
    if (!mayEvaluateToNumber(start)) {
      return false;
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
    }
  }

  if (delayCalls.some(delayMayBeReported)) {
    return true;
  }

  const clockVariables = new Set<string>();
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

  return trailingWords.some((name) => initializers.get(name)?.some((equals) => mayEvaluateToNumber(equals + 1)) === true);
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
    ["a timeout key in a type", "type T = { timeout?: number };", false],
    ["a destructured timeout parameter, kept because the scan cannot tell it from a key", "function f({ timeout }: { timeout: number }) {}", true],
    ["a timeout key given undefined", "const o = { timeout: undefined };", false],
    ["a small literal timeout", "const o = { 'timeout': 5 };", false],
    ["a delay under the flagged minimum", "setTimeout(r, 99);", false],
    ["a bare callback with no delay", "setTimeout(fn);", false],
    ["a mention of the delay word that is no call", "const s = setTimeout; vi.spyOn(globalThis, 'setTimeout');", false],
    ["a definition of the sleep helper, kept because the scan cannot tell it from a call", "function sleep(ms: number) { return ms; }", true],
    ["a clock read that never meets a subtraction", "const c = Date.now(); log(c);", false],
    ["a fixture timestamp that no clock read minus another", "const c6 = Date.now() - 86_400_000; expect(c6).toBe(1);", false],
    ["a source with no timing word at all", "export const answer = 6 * 7;\nit('x', () => { expect(answer).toBe(42); });", false],
  ];

  it.each(prefilterCases)("the prefilter agrees with the scanner on: %s", (_name, source, flagged) => {
    const reported = scanSource("sample.test.ts", source).length > 0;
    if (reported) {
      expect(mayHaveTimingViolation(source), `the scanner reports this, so the prefilter must keep it: ${source}`).toBe(true);
    }
    expect(mayHaveTimingViolation(source), `the prefilter verdict for: ${source}`).toBe(flagged);
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
