/** Comment-shape engine and gate: every comment in the repository's tracked TypeScript and JavaScript sources is a single line. A wrapped `/* *\/` or `/** *\/` block is one line, and a run of standalone `//` lines at the same indentation is one `//` line; tool directives (eslint, `@ts-`, prettier, istanbul, c8, `#region`, triple-slash) are exempt. It also refuses a one-line doc comment stacked directly on another doc comment, since only the second documents the declaration below and the first documents nothing (the shape a helper inserted between a doc and its function leaves behind). `--check` (default) is read-only and exits 1 on any finding; `--write` joins multi-line comments in place (stacked docs need a human to say which declaration owns them, so it only reports those); `--self-test` exercises the joiner against inline fixtures. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATTERNS = ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"];
const LINE_DIRECTIVE = /^\/\/\s*(eslint|@ts-|prettier-|istanbul|c8 |#region|#endregion)|^\/\/\//;
const BLOCK_DIRECTIVE = /^\/\*\s*(eslint|global |istanbul|c8 |prettier-)/;
const ONE_LINE_DOC = /^\s*\/\*\*.*\*\/\s*$/;
const DOC_OPEN = /^\s*\/\*\*/;

/** Every comment range in the file, once each: TypeScript reports a comment as leading trivia of one node and trailing trivia of another, so ranges are deduplicated by start position. */
function collectComments(sf) {
  const text = sf.getFullText();
  const seen = new Map();
  const add = (ranges) => {
    for (const range of ranges ?? []) {
      if (!seen.has(range.pos)) seen.set(range.pos, range);
    }
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

function lineStart(text, pos) {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function joinBlock(raw) {
  const isDoc = raw.startsWith("/**");
  const words = raw
    .slice(isDoc ? 3 : 2, -2)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*(?!\/)\s?/, "").trim())
    .filter((line) => line !== "")
    .join(" ");
  return `${isDoc ? "/**" : "/*"} ${words} */`;
}

/** Joins every multi-line comment in `text` onto one line, returning the rewritten text and how many comments were joined. `fileName` only picks the parser's script kind. */
export function joinComments(text, fileName) {
  const kind = /\.[mc]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const comments = collectComments(sf);
  const edits = [];
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const raw = text.slice(comment.pos, comment.end);
    if (comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (raw.includes("\n") && !BLOCK_DIRECTIVE.test(raw)) edits.push({ pos: comment.pos, end: comment.end, text: joinBlock(raw) });
      continue;
    }
    const indent = text.slice(lineStart(text, comment.pos), comment.pos);
    if (indent.trim() !== "" || LINE_DIRECTIVE.test(raw)) continue;
    let last = i;
    while (last + 1 < comments.length) {
      const next = comments[last + 1];
      const gap = text.slice(comments[last].end, next.pos).replace(/[ \t]+$/, "");
      const continues =
        next.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        /^\r?\n$/.test(gap) &&
        text.slice(lineStart(text, next.pos), next.pos) === indent &&
        !LINE_DIRECTIVE.test(text.slice(next.pos, next.end));
      if (!continues) break;
      last++;
    }
    if (last > i) {
      const parts = comments
        .slice(i, last + 1)
        .map((range) => text.slice(range.pos, range.end).replace(/^\/\/\s?/, "").trim())
        .filter((part) => part !== "");
      edits.push({ pos: comment.pos, end: comments[last].end, text: `// ${parts.join(" ")}` });
      i = last;
    }
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.end);
  return { out, count: edits.length };
}

/** 1-based line numbers of one-line doc comments that sit directly on another doc comment. */
export function findStackedDocs(text) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (ONE_LINE_DOC.test(lines[i]) && DOC_OPEN.test(lines[i + 1])) found.push(i + 1);
  }
  return found;
}

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z", "--", ...SOURCE_PATTERNS], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith("dist/"));
}

function run(write) {
  const findings = [];
  for (const file of trackedSources()) {
    const path = join(REPO_ROOT, file);
    const text = readFileSync(path, "utf8");
    const { out, count } = joinComments(text, file);
    if (count > 0) {
      if (write) writeFileSync(path, out);
      else findings.push(`${file}: ${count} multi-line comment(s)`);
    }
    for (const line of findStackedDocs(write ? out : text)) findings.push(`${file}:${line}: doc comment stacked on another doc comment -- move it onto the declaration it describes`);
  }
  for (const finding of findings) console.error(finding);
  if (findings.length > 0) {
    if (!write) console.error("Run 'npm run comments:write' to join multi-line comments.");
    process.exitCode = 1;
  }
}

function selfTest() {
  const cases = [
    ["/**\n * Alpha\n * beta.\n */\nexport const a = 1;\n", "/** Alpha beta. */\nexport const a = 1;\n"],
    ["// one\n// two\nconst b = 2;\n", "// one two\nconst b = 2;\n"],
    ["  // inner\n  // run\n// outer\n", "  // inner run\n// outer\n"],
    ["// one\n\n// two\n", "// one\n\n// two\n"],
    ["// eslint-disable-next-line no-console\n// why\nconsole.log(1);\n", "// eslint-disable-next-line no-console\n// why\nconsole.log(1);\n"],
    ["/* eslint-disable\n   no-console */\n", "/* eslint-disable\n   no-console */\n"],
    ["const c = 3; // trailing\n// standalone\n", "const c = 3; // trailing\n// standalone\n"],
    ["const s = \"/**\\n * not a comment\\n */\";\n", "const s = \"/**\\n * not a comment\\n */\";\n"],
  ];
  let failed = 0;
  for (const [input, expected] of cases) {
    const { out } = joinComments(input, "fixture.ts");
    if (out !== expected) {
      failed++;
      console.error(`FAIL\n  input:    ${JSON.stringify(input)}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(out)}`);
    }
  }
  const stacked = findStackedDocs("/** Orphan. */\n/** Owner. */\nfunction f() {}\n/** Fine. */\nconst g = 1;\n");
  if (JSON.stringify(stacked) !== "[1]") {
    failed++;
    console.error(`FAIL stacked docs: expected [1], got ${JSON.stringify(stacked)}`);
  }
  console.log(`${cases.length + 1 - failed}/${cases.length + 1} self-test cases passed`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--self-test") selfTest();
  else if (mode === "--check" || mode === "--write") run(mode === "--write");
  else {
    console.error(`unknown mode ${mode}; expected --check, --write, or --self-test`);
    process.exitCode = 1;
  }
}
