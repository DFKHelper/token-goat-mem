/** Comment-shape engine and gate: every comment in the repository's tracked TypeScript and JavaScript sources is a single line. A wrapped `/* *\/` or `/** *\/` block is one line, and a run of standalone `//` lines at the same indentation is one `//` line; tool directives (eslint, `@ts-`, prettier, istanbul, c8, `#region`, triple-slash) are exempt. It also refuses a one-line doc comment stacked directly on another doc comment, since only the second documents the declaration below and the first documents nothing (the shape a helper inserted between a doc and its function leaves behind). `--check` (default) is read-only and exits 1 on any finding; `--write` joins multi-line comments in place (stacked docs need a human to say which declaration owns them, so it only reports those); `--self-test` exercises the joiner against inline fixtures. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** A `/*` with a line break before the next `*\/`: every multi-line block comment starts that way, so a text without one has none (a string or regex that merely looks like one only costs the parse). */
const BLOCK_SPANS_LINES = /\/\*(?:[^*\n]|\*(?!\/))*\n/;
/** Two `//` lines in a row at one indentation: the only shape a run of standalone `//` comments can take, so a text without it has no run to join. */
const COMMENT_RUN = /^([^\S\r\n]*)\/\/[^\r\n]*\r?\n\1\/\//m;
/** A lone CR or a Unicode line separator ends a `//` comment in the scanner but not in the two patterns above, so a text holding one always takes the parse. */
const LONE_CR = /\r(?!\n)/;
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** True when the patterns cannot rule out a joinable comment; a false answer proves `joinComments` has nothing to join, so the parse is skipped. */
function mayHaveJoinableComment(text) {
  return LONE_CR.test(text) || LINE_SEPARATORS.some((separator) => text.includes(separator)) || BLOCK_SPANS_LINES.test(text) || COMMENT_RUN.test(text);
}

/** Joins every multi-line comment in `text` onto one line, returning the rewritten text and how many comments were joined. `fileName` only picks the parser's script kind. */
export function joinComments(text, fileName) {
  if (!mayHaveJoinableComment(text)) return { out: text, count: 0 };
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

const SOURCE_EXTENSION = /\.(ts|mts|cts|js|mjs|cjs)$/;
const INDEX_FIXED_BYTES = 62;
const INDEX_CHECKSUM_BYTES = 20;

/** Reads one entry's path from a version 4 index: git's offset-encoded count of bytes to drop from the previous path, then the NUL-terminated rest. */
function readPrefixedPath(buf, at, previous) {
  let byte = buf[at++];
  let strip = byte & 127;
  while (byte & 128) {
    byte = buf[at++];
    strip = ((strip + 1) << 7) + (byte & 127);
  }
  const nul = buf.indexOf(0, at);
  if (nul < 0 || strip > previous.length) return undefined;
  return { name: Buffer.concat([previous.subarray(0, previous.length - strip), buf.subarray(at, nul)]), next: nul + 1 };
}

/** The paths in a git index (versions 2 to 4) in index order, or undefined when the bytes are anything this reader does not fully understand (a bad checksum, another version, an unmerged, sparse or split-index entry), so the caller asks git instead of guessing. */
export function readIndexPaths(buf) {
  const end = buf.length - INDEX_CHECKSUM_BYTES;
  if (end < 12 || buf.toString("latin1", 0, 4) !== "DIRC") return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  if (!createHash("sha1").update(buf.subarray(0, end)).digest().equals(buf.subarray(end))) return undefined;
  const count = buf.readUInt32BE(8);
  const paths = [];
  let previous = Buffer.alloc(0);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos + INDEX_FIXED_BYTES > end) return undefined;
    const mode = buf.readUInt32BE(pos + 24);
    const flags = buf.readUInt16BE(pos + 60);
    const header = INDEX_FIXED_BYTES + (flags & 0x4000 ? 2 : 0);
    if (flags & 0x3000 || (mode & 0o170000) === 0o040000 || (flags & 0x4000 && version < 3)) return undefined;
    let name;
    if (version === 4) {
      const entry = readPrefixedPath(buf, pos + header, previous);
      if (entry === undefined) return undefined;
      name = entry.name;
      previous = name;
      pos = entry.next;
    } else {
      const nul = buf.indexOf(0, pos + header);
      if (nul < 0) return undefined;
      name = buf.subarray(pos + header, nul);
      pos += (header + name.length + 8) & ~7;
    }
    paths.push(name.toString("utf8"));
  }
  while (pos + 8 <= end) {
    const signature = buf.toString("latin1", pos, pos + 4);
    if (signature === "link" || signature === "sdir") return undefined;
    pos += 8 + buf.readUInt32BE(pos + 4);
  }
  return pos === end ? paths : undefined;
}

/** The tracked paths straight from the repository's own index file, or undefined when `root` is not a plain repository root or the index is not one `readIndexPaths` fully understands. */
function indexedPaths(root) {
  if (process.env.GIT_DIR !== undefined || process.env.GIT_INDEX_FILE !== undefined || process.env.GIT_WORK_TREE !== undefined) return undefined;
  try {
    return readIndexPaths(readFileSync(join(root, ".git", "index")));
  } catch {
    return undefined;
  }
}

/** Every tracked TypeScript and JavaScript source under `root` except `dist/`: read from the index in-process (no process start, which costs seconds on a loaded host), with `git ls-files` as the fallback. The extension test is case-sensitive, as git's `*.ts` pathspec is even under core.ignorecase. */
export function trackedSources(root) {
  const indexed = indexedPaths(root);
  const paths = indexed?.filter((file) => SOURCE_EXTENSION.test(file)) ?? execFileSync("git", ["ls-files", "-z", "--", ...SOURCE_PATTERNS], { cwd: root, encoding: "utf8" }).split("\0");
  return paths.filter((file) => file !== "" && !file.startsWith("dist/"));
}

/** Runs the comment-shape pass over `files` (default: the tracked sources under `root`); `write` joins multi-line comments in place, and `output` is the stderr lines the CLI prints. */
export function runCommentCheck({ write = false, root = REPO_ROOT, files } = {}) {
  const findings = [];
  for (const file of files ?? trackedSources(root)) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const { out, count } = joinComments(text, file);
    if (count > 0) {
      if (write) writeFileSync(path, out);
      else findings.push(`${file}: ${count} multi-line comment(s)`);
    }
    for (const line of findStackedDocs(write ? out : text)) findings.push(`${file}:${line}: doc comment stacked on another doc comment -- move it onto the declaration it describes`);
  }
  if (findings.length === 0) return { exitCode: 0, output: [] };
  if (!write) findings.push("Run 'npm run comments:write' to join multi-line comments.");
  return { exitCode: 1, output: findings };
}

function run(write) {
  const { exitCode, output } = runCommentCheck({ write });
  for (const line of output) console.error(line);
  process.exitCode = exitCode;
}

/** Runs the joiner and stacked-doc fixtures and returns the failure lines, the verdict and the summary line the CLI prints. */
export function runSelfTest() {
  const cases = [
    ["/**\n * Alpha\n * beta.\n */\nexport const a = 1;\n", "/** Alpha beta. */\nexport const a = 1;\n"],
    ["// one\n// two\nconst b = 2;\n", "// one two\nconst b = 2;\n"],
    ["  // inner\n  // run\n// outer\n", "  // inner run\n// outer\n"],
    ["// one\n\n// two\n", "// one\n\n// two\n"],
    ["// eslint-disable-next-line no-console\n// why\nconsole.log(1);\n", "// eslint-disable-next-line no-console\n// why\nconsole.log(1);\n"],
    ["/* eslint-disable\n   no-console */\n", "/* eslint-disable\n   no-console */\n"],
    ["const c = 3; // trailing\n// standalone\n", "const c = 3; // trailing\n// standalone\n"],
    ["// a\r\n// b\r\nconst c = 1;\r\n", "// a b\r\nconst c = 1;\r\n"],
    ["/**\r\n * a\r\n * b\r\n */\r\nconst c = 1;\r\n", "/** a b */\r\nconst c = 1;\r\n"],
    ["\t// a\n\t// b\nconst c = 1;\n", "\t// a b\nconst c = 1;\n"],
    ["/*/\n x */\nconst c = 1;\n", "/* / x */\nconst c = 1;\n"],
    ["const g = \"src/**/*.ts\";\n// a\n// b\n", "const g = \"src/**/*.ts\";\n// a b\n"],
    ["// a\r// b\rconst c = 1;\r", "// a\r// b\rconst c = 1;\r"],
    ["const s = `\n// a\n// b\n`;\n", "const s = `\n// a\n// b\n`;\n"],
    ["const s = \"/**\\n * not a comment\\n */\";\n", "const s = \"/**\\n * not a comment\\n */\";\n"],
  ];
  const failures = [];
  for (const [input, expected] of cases) {
    const { out } = joinComments(input, "fixture.ts");
    if (out !== expected) {
      failures.push(`FAIL\n  input:    ${JSON.stringify(input)}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(out)}`);
    }
  }
  const stacked = findStackedDocs("/** Orphan. */\n/** Owner. */\nfunction f() {}\n/** Fine. */\nconst g = 1;\n");
  if (JSON.stringify(stacked) !== "[1]") {
    failures.push(`FAIL stacked docs: expected [1], got ${JSON.stringify(stacked)}`);
  }
  const total = cases.length + 1;
  return { pass: failures.length === 0, failures, summary: `${total - failures.length}/${total} self-test cases passed` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--self-test") {
    const result = runSelfTest();
    for (const line of result.failures) console.error(line);
    console.log(result.summary);
    if (!result.pass) process.exitCode = 1;
  } else if (mode === "--check" || mode === "--write") run(mode === "--write");
  else {
    console.error(`unknown mode ${mode}; expected --check, --write, or --self-test`);
    process.exitCode = 1;
  }
}
