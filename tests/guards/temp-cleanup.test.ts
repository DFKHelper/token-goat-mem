/** Source-level guard that no test leaves a temp directory behind: every `mkdtemp`/`mkdtempSync` result is removed by an `rmSync`/`rm` inside an `afterEach`, `afterAll` or `onTestFinished` callback, a `finally` block, or a teardown function its creator returns, within the scope that holds the name. A removal registered with `process.on("exit")` does not count, because vitest terminates workers rather than letting them exit. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "guards/temp-cleanup.test.ts";
const SOURCE_EXTENSION = /\.(ts|mts|cts|mjs|cjs|js)$/u;

/** The calls that create a temp directory. */
const CREATORS = new Set(["mkdtempSync", "mkdtemp"]);
/** The calls that remove one. */
const REMOVERS = new Set(["rmSync", "rm", "rmdirSync", "rmdir"]);
/** The callee roots whose callback runs on every path of a test or file, the failing one included. */
const CLEANUP_HOOKS = new Set(["afterEach", "afterAll", "onTestFinished"]);
/** The calls that hand their first argument's path on unchanged in form, so the directory is still what is bound. */
const PASS_THROUGH = new Set(["realpathSync", "realpath", "resolve", "normalize", "join"]);
/** The deepest chain of helpers that return a directory another helper returns. */
const MAX_HELPER_DEPTH = 3;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly lineText: string;
}

interface Source {
  readonly file: string;
  readonly text: string;
}

interface Parsed extends Source {
  readonly sf: ts.SourceFile;
  readonly lines: string[];
}

/** Where a created directory goes: a name (or an array of them) it must be removed through, a helper that returns it for its callers to place, or nowhere the guard can follow. */
type Sink =
  | { readonly kind: "bound"; readonly name: string; readonly scope: ts.Node; readonly array: boolean }
  | { readonly kind: "returned"; readonly factory: string }
  | { readonly kind: "lost"; readonly why: string };

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

/** The identifier at the root of `afterEach`, `it.each(table)` and the like. */
function calleeRoot(call: ts.CallExpression): string | undefined {
  let node: ts.Expression = call.expression;
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

/** `node` with the parentheses, casts and non-null marks around it removed. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isFunctionNode(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

/** The name a function is reached by: its own, or the variable or property it is assigned to. */
function functionName(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined && ts.isIdentifier(fn.name)) {
    return fn.name.text;
  }
  const parent = fn.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !isFunctionNode(current)) {
    current = current.parent;
  }
  return current;
}

/** The block, file or function body that declares `name` as seen from `from`: the nearest enclosing one that holds a variable statement or a parameter of that name, or the file when none does (a property, an import or a global). */
function scopeOf(from: ts.Node, name: string): ts.Node {
  let current: ts.Node | undefined = from.parent;
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      const declares = current.statements.some(
        (statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name),
      );
      if (declares) {
        return current;
      }
    } else if (isFunctionNode(current) && current.body !== undefined && current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) {
      return current.body;
    }
    current = current.parent;
  }
  return from.getSourceFile();
}

/** The identifier an access chain starts at (`ctx` in `ctx.root`), or `undefined` for one that starts at `this` or a call. */
function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

/** Where the directory a call returns ends up, read through the casts, awaits and path helpers around it. */
function sinkOf(call: ts.CallExpression): Sink {
  let node: ts.Expression = call;
  for (;;) {
    const parent: ts.Node = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent)) {
      node = parent;
    } else if (ts.isCallExpression(parent) && parent.arguments[0] === node && PASS_THROUGH.has(calleeName(parent) ?? "")) {
      node = parent;
    } else {
      break;
    }
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return ts.isIdentifier(parent.name) ? { kind: "bound", name: parent.name.text, scope: scopeOf(parent.name, parent.name.text), array: false } : { kind: "lost", why: "bound by a destructuring pattern" };
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
    const root = rootIdentifier(parent.left);
    return { kind: "bound", name: parent.left.getText(), scope: root === undefined ? node.getSourceFile() : scopeOf(parent.left, root.text), array: false };
  }
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "push" && parent.arguments.includes(node)) {
    const root = rootIdentifier(parent.expression.expression);
    return { kind: "bound", name: parent.expression.expression.getText(), scope: root === undefined ? node.getSourceFile() : scopeOf(parent, root.text), array: true };
  }
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
    const factory = functionName(ts.isReturnStatement(parent) ? enclosingFunction(parent) ?? parent : parent);
    return factory === undefined ? { kind: "lost", why: "returned from a function with no name to follow" } : { kind: "returned", factory };
  }
  return { kind: "lost", why: "not bound to a name the guard can follow" };
}

/** Whether `node` runs on every path of a test or file: it sits in a cleanup hook's callback, in a `finally` block, or in a function that is handed to a hook, returned to its caller, or called from such a place. */
function runsOnEveryPath(node: ts.Node, depth = 0): boolean {
  const sf = node.getSourceFile();
  if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression) && CLEANUP_HOOKS.has(calleeRoot(node.parent) ?? "")) {
    return true;
  }
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isBlock(current) && ts.isTryStatement(current.parent) && current.parent.finallyBlock === current) {
      return true;
    }
    if (!isFunctionNode(current)) {
      continue;
    }
    if (ts.isCallExpression(current.parent) && current.parent.arguments.includes(current as ts.Expression) && CLEANUP_HOOKS.has(calleeRoot(current.parent) ?? "")) {
      return true;
    }
    if (ts.isReturnStatement(current.parent)) {
      return true;
    }
    const name = functionName(current);
    if (name !== undefined && depth < MAX_HELPER_DEPTH) {
      let reached = false;
      walk(sf, (inner) => {
        if (reached) {
          return;
        }
        if (ts.isReturnStatement(inner) && inner.expression !== undefined && ts.isIdentifier(inner.expression) && inner.expression.text === name) {
          reached = true;
        } else if (ts.isIdentifier(inner) && inner.text === name && inner !== (current as ts.FunctionLikeDeclaration).name && inner.parent !== current.parent) {
          reached = runsOnEveryPath(inner, depth + 1);
        }
      });
      if (reached) {
        return true;
      }
    }
  }
  return false;
}

/** Whether `node` sits in a function that `process.on("exit", ...)` or `process.once("exit", ...)` registers. */
function inExitHandler(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionNode(current) && ts.isCallExpression(current.parent) && ["on", "once", "addListener"].includes(calleeName(current.parent) ?? "")) {
      const [event] = current.parent.arguments;
      if (event !== undefined && ts.isStringLiteralLike(event) && event.text === "exit") {
        return true;
      }
    }
  }
  return false;
}

/** The directory a removal's argument deletes: the argument itself, or the parent of a path made inside the created directory (`join(dir, "..")`, `dirname(dir)`). */
function removedPath(argument: ts.Expression): ts.Expression {
  const target = unwrap(argument);
  if (ts.isCallExpression(target)) {
    const [first, second] = target.arguments;
    const name = calleeName(target);
    if (first !== undefined && (name === "join" || name === "resolve") && target.arguments.length === 2 && second !== undefined && ts.isStringLiteralLike(second) && second.text === "..") {
      return unwrap(first);
    }
    if (first !== undefined && name === "dirname" && target.arguments.length === 1) {
      return unwrap(first);
    }
  }
  return target;
}

/** The expressions a loop variable takes its values from: the subject of the `for...of` that declares it, or the array a `forEach`/`map` callback takes it as its first parameter from. */
function iterablesOf(variable: ts.Identifier): ts.Expression[] {
  const found: ts.Expression[] = [];
  for (let current: ts.Node | undefined = variable.parent; current !== undefined; current = current.parent) {
    if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer) && current.initializer.declarations.some((declaration) => declaration.name.getText() === variable.text)) {
      found.push(current.expression);
    } else if (isFunctionNode(current) && ts.isCallExpression(current.parent) && ts.isPropertyAccessExpression(current.parent.expression) && current.parameters[0]?.name.getText() === variable.text) {
      found.push(current.parent.expression.expression);
    }
  }
  return found;
}

/** Whether the removal's argument deletes the bound directory: it is the name, or a loop variable over the name's array or over an array literal that lists the name. */
function removesName(argument: ts.Expression, sink: Extract<Sink, { kind: "bound" }>): boolean {
  const target = removedPath(argument);
  if (!sink.array && target.getText() === sink.name) {
    return true;
  }
  return ts.isIdentifier(target) && iterablesOf(target).some((subject) => (sink.array ? subject.getText() === sink.name : ts.isArrayLiteralExpression(subject) && subject.elements.some((element) => unwrap(element).getText() === sink.name)));
}

/** Why a bound directory is not removed on every path, or `undefined` when it is. */
function unremovedReason(sink: Extract<Sink, { kind: "bound" }>): string | undefined {
  let removedSomewhere = false;
  let onlyAtExit = false;
  let everyPath = false;
  walk(sink.scope, (node) => {
    if (everyPath || !ts.isCallExpression(node) || !REMOVERS.has(calleeName(node) ?? "")) {
      return;
    }
    const [argument] = node.arguments;
    if (argument === undefined || !removesName(argument, sink)) {
      return;
    }
    removedSomewhere = true;
    if (runsOnEveryPath(node)) {
      everyPath = true;
    } else if (inExitHandler(node)) {
      onlyAtExit = true;
    }
  });
  if (everyPath) {
    return undefined;
  }
  if (onlyAtExit) {
    return `\`${sink.name}\` is removed only by a process exit handler, which a terminated vitest worker never runs; remove it in afterEach, afterAll, onTestFinished or a finally block`;
  }
  return removedSomewhere
    ? `\`${sink.name}\` is removed, but not in an afterEach, afterAll or onTestFinished callback or a finally block, so a failing path leaves it behind`
    : `\`${sink.name}\` is never removed in the scope that holds it`;
}

/** Whether `call` creates its directory inside another created directory that is itself removed on every path (`mkdtempSync(join(base, "home-"))` with `base` removed in afterEach): removing the parent takes this one with it. */
function nestedInRemoved(sf: ts.SourceFile, call: ts.CallExpression, seen: ReadonlySet<ts.Node> = new Set()): boolean {
  const [first] = call.arguments;
  if (first === undefined) {
    return false;
  }
  let parent = unwrap(first);
  if (ts.isCallExpression(parent) && (calleeName(parent) === "join" || calleeName(parent) === "resolve") && parent.arguments[0] !== undefined) {
    parent = unwrap(parent.arguments[0]);
  }
  if (!ts.isIdentifier(parent)) {
    return false;
  }
  const parentName = parent.text;
  let covered = false;
  walk(sf, (node) => {
    if (covered || node === call || seen.has(node) || !ts.isCallExpression(node) || !CREATORS.has(calleeName(node) ?? "")) {
      return;
    }
    const sink = sinkOf(node);
    covered = sink.kind === "bound" && sink.name === parentName && (unremovedReason(sink) === undefined || nestedInRemoved(sf, node, new Set([...seen, call])));
  });
  return covered;
}

/** Every created temp directory in `sources` that is not removed on every path. A directory a helper returns is followed to the helper's callers in any of the sources, by the helper's name. */
function findLeaks(sources: readonly Source[]): Finding[] {
  const parsed: Parsed[] = sources.map(({ file, text }) => ({ file, text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS), lines: text.split("\n") }));
  const found = new Map<string, Finding>();
  const factories = new Map<string, number>();
  const check = (source: Parsed, call: ts.CallExpression, depth: number): void => {
    if (CREATORS.has(calleeName(call) ?? "") && nestedInRemoved(source.sf, call)) {
      return;
    }
    const sink = sinkOf(call);
    let problem: string | undefined;
    if (sink.kind === "lost") {
      problem = `the temp directory is ${sink.why}`;
    } else if (sink.kind === "returned") {
      if (depth >= MAX_HELPER_DEPTH) {
        problem = `\`${sink.factory}\` returns the directory down a chain of more than ${MAX_HELPER_DEPTH} helpers`;
      } else if (!factories.has(sink.factory)) {
        factories.set(sink.factory, depth);
      }
    } else {
      problem = unremovedReason(sink);
    }
    if (problem !== undefined) {
      const line = source.sf.getLineAndCharacterOfPosition(call.getStart(source.sf)).line + 1;
      found.set(`${source.file}:${line}`, { file: source.file, line, detail: problem, lineText: (source.lines[line - 1] ?? "").trim() });
    }
  };
  for (const source of parsed) {
    if (source.text.includes("mkdtemp")) {
      walk(source.sf, (node) => {
        if (ts.isCallExpression(node) && CREATORS.has(calleeName(node) ?? "")) {
          check(source, node, 0);
        }
      });
    }
  }
  const followed = new Set<string>();
  for (let round = 0; round <= MAX_HELPER_DEPTH; round++) {
    for (const [factory, depth] of [...factories]) {
      if (followed.has(factory)) {
        continue;
      }
      followed.add(factory);
      for (const source of parsed) {
        if (source.text.includes(factory)) {
          walk(source.sf, (node) => {
            if (ts.isCallExpression(node) && calleeName(node) === factory) {
              check(source, node, depth + 1);
            }
          });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

function describeFinding(finding: Finding): string {
  return `${finding.file}:${finding.line}: ${finding.detail} -- ${finding.lineText}`;
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

describe("tests remove every temp directory they create", () => {
  const sources = listTestSources(TESTS_DIR);

  it("scans the real test tree, so an empty walk cannot pass vacuously", () => {
    const creators = sources.filter((file) => readFileSync(join(TESTS_DIR, file), "utf8").includes("mkdtemp"));

    expect(sources.length, "the walk of tests/ found too few sources").toBeGreaterThan(50);
    expect(creators.length, "the walk found too few files that create a temp directory").toBeGreaterThan(30);
    expect(sources, "the walk must reach nested directories").toContain("unit/budgetClock.test.ts");
    expect(sources, "the guard excludes itself").not.toContain(SELF);
  });

  it("no test creates a temp directory it does not remove on every path", () => {
    const leaks = findLeaks(sources.map((file) => ({ file, text: readFileSync(join(TESTS_DIR, file), "utf8") })));

    expect(leaks.map(describeFinding), "temp directories created without cleanup in tests/").toEqual([]);
  });

  const scan = (text: string, extra: readonly Source[] = []): string[] => findLeaks([{ file: "sample.test.ts", text }, ...extra]).map((finding) => `${finding.file}:${finding.line}`);

  it.each([
    ["a bare mkdtempSync", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  use(dir);\n});', ["sample.test.ts:2"]],
    ["a removal in the test body, which a failure skips", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  use(dir);\n  rmSync(dir, { recursive: true, force: true });\n});', ["sample.test.ts:2"]],
    ["a removal only through process.on exit", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));\n});', ["sample.test.ts:2"]],
    ["a removal only through process.once exit", 'const dir = mkdtempSync(join(tmpdir(), "mem-"));\nprocess.once("exit", () => {\n  rmSync(dir, { recursive: true, force: true });\n});', ["sample.test.ts:1"]],
    ["an await mkdtemp that is never removed", 'it("x", async () => {\n  const dir = await mkdtemp(join(tmpdir(), "mem-"));\n  use(dir);\n});', ["sample.test.ts:2"]],
    ["a result handed straight to a call", 'it("x", () => {\n  use(mkdtempSync(join(tmpdir(), "mem-")));\n});', ["sample.test.ts:2"]],
    ["a result unpacked by a pattern", 'const { a } = mkdtempSync(join(tmpdir(), "mem-"));', ["sample.test.ts:1"]],
    ["a removal of a different name in a hook", 'let root;\nafterEach(() => {\n  rmSync(other, { recursive: true, force: true });\n});\nit("x", () => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});', ["sample.test.ts:6"]],
    ["a removal in a hook of another test's directory of the same name", 'it("a", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));\n});\nit("b", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  use(dir);\n});', ["sample.test.ts:6"]],
    ["a removal in a hook declared in a sibling describe", 'describe("a", () => {\n  let root;\n  afterEach(() => rmSync(root, { recursive: true, force: true }));\n});\ndescribe("b", () => {\n  let root;\n  beforeEach(() => {\n    root = mkdtempSync(join(tmpdir(), "mem-"));\n  });\n});', ["sample.test.ts:8"]],
    ["a helper whose caller drops the result", 'function makeDir() {\n  return mkdtempSync(join(tmpdir(), "mem-"));\n}\nit("x", () => {\n  makeDir();\n});', ["sample.test.ts:5"]],
    ["a helper whose caller keeps the result without removing it", 'const makeDir = () => mkdtempSync(join(tmpdir(), "mem-"));\nit("x", () => {\n  const dir = makeDir();\n  use(dir);\n});', ["sample.test.ts:3"]],
    ["a pushed directory that is never removed", 'const dirs: string[] = [];\nit("x", () => {\n  dirs.push(mkdtempSync(join(tmpdir(), "mem-")));\n});', ["sample.test.ts:3"]],
    ["a removal of a path inside the directory, which leaves the directory", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => rmSync(join(root, "sub"), { recursive: true, force: true }));', ["sample.test.ts:3"]],
    ["a directory made inside a parent that is never removed", 'it("x", () => {\n  const base = mkdtempSync(join(tmpdir(), "mem-"));\n  const home = mkdtempSync(join(base, "home-"));\n  use(home);\n});', ["sample.test.ts:2", "sample.test.ts:3"]],
    ["a loop over an array literal that does not list the directory", 'let a;\nlet b;\nbeforeEach(() => {\n  a = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => {\n  for (const dir of [b]) {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});', ["sample.test.ts:4"]],
    ["a hook that creates a directory and removes a different one", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => {\n  rmSync(join(root, "sub"), { recursive: true, force: true });\n});', ["sample.test.ts:3"]],
  ])("reports %s", (_name, source, expected) => {
    expect(scan(source)).toEqual(expected);
  });

  it.each([
    ["a removal in onTestFinished", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));\n});'],
    ["a removal in onTestFinished with a block body", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  onTestFinished(() => {\n    rmSync(dir, { recursive: true, force: true });\n  });\n});'],
    ["a removal in a finally block", 'it("x", () => {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  try {\n    use(dir);\n  } finally {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});'],
    ["a removal in afterEach of a name assigned in beforeEach", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => {\n  rmSync(root, { recursive: true, force: true });\n});'],
    ["a removal in afterAll of a name assigned in beforeAll", 'let root: string;\nbeforeAll(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterAll(() => {\n  rmSync(root, { recursive: true, force: true });\n});'],
    ["a removal in afterEach of a name a describe holds", 'describe("a", () => {\n  let root;\n  beforeEach(() => {\n    root = mkdtempSync(join(tmpdir(), "mem-"));\n  });\n  afterEach(() => rmSync(root, { recursive: true, force: true }));\n});'],
    ["a realpath around the creation", 'let root;\nbeforeEach(() => {\n  root = realpathSync(mkdtempSync(join(tmpdir(), "mem-")));\n});\nafterEach(() => rmSync(root, { recursive: true, force: true }));'],
    ["a cast around the removal argument", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => rmSync(root as string, { recursive: true, force: true }));'],
    ["a property assigned and removed in a hook", 'const ctx = { root: "" };\nbeforeEach(() => {\n  ctx.root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => rmSync(ctx.root, { recursive: true, force: true }));'],
    ["a removal by an async rm in afterEach", 'let root;\nbeforeEach(async () => {\n  root = await mkdtemp(join(tmpdir(), "mem-"));\n});\nafterEach(async () => {\n  await fsp.rm(root, { recursive: true, force: true });\n});'],
    ["a removal in a named cleanup function a hook is handed", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nfunction cleanup() {\n  rmSync(root, { recursive: true, force: true });\n}\nafterEach(cleanup);'],
    ["a removal in a named cleanup function a hook calls", 'let root;\nbeforeEach(() => {\n  root = mkdtempSync(join(tmpdir(), "mem-"));\n});\nconst cleanup = () => {\n  rmSync(root, { recursive: true, force: true });\n};\nafterEach(() => {\n  cleanup();\n});'],
    ["a teardown function the creator returns", 'export default function setup() {\n  const dir = mkdtempSync(join(tmpdir(), "mem-"));\n  const teardown = (): void => {\n    rmSync(dir, { recursive: true, force: true });\n  };\n  return teardown;\n}'],
    ["pushed directories removed by a for-of loop in afterEach", 'const dirs: string[] = [];\nafterEach(() => {\n  for (const dir of dirs) {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});\nit("x", () => {\n  dirs.push(mkdtempSync(join(tmpdir(), "mem-")));\n});'],
    ["pushed directories removed by forEach in afterAll", 'const dirs: string[] = [];\nafterAll(() => {\n  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));\n});\nit("x", () => {\n  dirs.push(mkdtempSync(join(tmpdir(), "mem-")));\n});'],
    ["a helper whose caller removes the result in onTestFinished", 'function makeDir() {\n  return mkdtempSync(join(tmpdir(), "mem-"));\n}\nit("x", () => {\n  const dir = makeDir();\n  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));\n});'],
    ["an arrow helper whose caller removes the result in a finally block", 'const makeDir = () => mkdtempSync(join(tmpdir(), "mem-"));\nit("x", () => {\n  const dir = makeDir();\n  try {\n    use(dir);\n  } finally {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});'],
    ["a removal of the parent of a path made inside the directory", 'it("x", () => {\n  const home = join(mkdtempSync(join(tmpdir(), "mem-")), "file");\n  try {\n    use(home);\n  } finally {\n    rmSync(join(home, ".."), { recursive: true, force: true });\n  }\n});'],
    ["a removal through dirname of a path made inside the directory", 'it("x", () => {\n  const home = join(mkdtempSync(join(tmpdir(), "mem-")), "file");\n  onTestFinished(() => rmSync(dirname(home), { recursive: true, force: true }));\n});'],
    ["a loop over an array literal listing the directories", 'let a;\nlet b;\nbeforeEach(() => {\n  a = mkdtempSync(join(tmpdir(), "mem-"));\n  b = mkdtempSync(join(tmpdir(), "mem-"));\n});\nafterEach(() => {\n  for (const dir of [a, b]) {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});'],
    ["a directory made inside a parent that is removed in afterEach", 'let base;\nlet home;\nbeforeEach(() => {\n  base = mkdtempSync(join(tmpdir(), "mem-"));\n  home = mkdtempSync(join(base, "home-"));\n});\nafterEach(() => rmSync(base, { recursive: true, force: true }));'],
    ["a no-creation source", 'it("x", () => {\n  const dir = join(tmpdir(), "mem-");\n  rmSync(dir, { recursive: true, force: true });\n});'],
  ])("accepts %s", (_name, source) => {
    expect(scan(source)).toEqual([]);
  });

  it("follows a helper to its callers in another source", () => {
    const helper = 'export function makeDir() {\n  return mkdtempSync(join(tmpdir(), "mem-"));\n}';
    const leaky = 'it("x", () => {\n  const dir = makeDir();\n  use(dir);\n});';
    const clean = 'it("x", () => {\n  const dir = makeDir();\n  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));\n});';

    expect(findLeaks([{ file: "support/dirs.ts", text: helper }, { file: "a.test.ts", text: leaky }]).map((finding) => `${finding.file}:${finding.line}`)).toEqual(["a.test.ts:2"]);
    expect(findLeaks([{ file: "support/dirs.ts", text: helper }, { file: "a.test.ts", text: clean }])).toEqual([]);
  });

  it("names the exit handler when that is the only removal", () => {
    const [finding] = findLeaks([{ file: "a.test.ts", text: 'const dir = mkdtempSync(join(tmpdir(), "mem-"));\nprocess.on("exit", () => rmSync(dir, { force: true }));' }]);

    expect(finding?.detail).toContain("process exit handler");
  });
});
