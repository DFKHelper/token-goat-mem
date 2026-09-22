#!/usr/bin/env node
/**
 * Architecture-documentation sync engine and gate.
 *
 * Discovers every source component via `git ls-files` against the patterns in
 * `.arch-doc-sync.json`, classifies each into a declared layer by exact path membership, extracts a
 * one-sentence Role and up to five exported symbol names, and splices the resulting table between the
 * `ARCH_COMPONENTS_START`/`END` markers in the configured doc (`ARCHITECTURE.md`).
 *
 * `--check` (default) is read-only and never mutates the doc; it recomputes the table from the
 * current tree and byte-compares it against what is currently spliced in, so any difference at all
 * -- a new module, a removed one, a changed export list, a module that matches no declared layer --
 * is drift. `--write` performs the splice. `--self-test` exercises the contract hermetically in a
 * temp directory.
 *
 * Curated Roles (a Role a human edited by hand, which by definition differs from what extraction
 * would produce for that path today) are never overwritten. When a curated module's path disappears
 * from the discovered set, `git diff --name-status -M -C HEAD` is consulted before treating the row
 * as deleted: a single rename target re-keys the curated Role; more than one target from the same old
 * path (a rename plus one or more copies) is treated as a split, and the Role is duplicated to every
 * child with a `(split from <old path>)` suffix; more than one old path landing on the same new path
 * is treated as a merge, keeping the longest curated Role and discarding the rest. Every drop,
 * re-key, duplication, and merge is reported on stderr -- never silent.
 *
 * Zero dependencies, Node 18 compatible: only `node:fs`, `node:path`, `node:child_process`,
 * `node:url`, `node:os`. No build step, matching `esbuild.config.mjs`'s own plain-ESM precedent.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const START_MARKER = "<!-- ARCH_COMPONENTS_START -->";
const END_MARKER = "<!-- ARCH_COMPONENTS_END -->";
const CONFIG_FILE = ".arch-doc-sync.json";
const UNCATEGORIZED = "Uncategorized";

class SyncError extends Error {}

// ---------------------------------------------------------------------------
// Config, discovery
// ---------------------------------------------------------------------------

function loadConfig(repoRoot) {
  const configPath = join(repoRoot, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new SyncError(`Missing config file: expected ${configPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new SyncError(`Malformed config at ${configPath}: ${error.message}`);
  }
  if (typeof parsed.doc !== "string" || !Array.isArray(parsed.patterns) || !Array.isArray(parsed.layers)) {
    throw new SyncError(`Config at ${configPath} must define string "doc", array "patterns", array "layers"`);
  }
  return {
    doc: parsed.doc,
    patterns: parsed.patterns,
    layers: parsed.layers,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
  };
}

function ensureGitRepo(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== "true") {
    throw new SyncError(`Not inside a git work tree: ${repoRoot} (arch-doc-sync requires git ls-files for discovery)`);
  }
}

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Minimal glob-to-RegExp: `*` matches within a path segment, `**` matches across segments. */
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re, "u");
}

function applyExclude(paths, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) return paths;
  const regexes = excludePatterns.map(globToRegExp);
  return paths.filter((p) => !regexes.some((r) => r.test(p)));
}

/** Enumerates components via `git ls-files`, never a filesystem walk -- see module header. */
function listComponents(repoRoot, patterns, excludePatterns) {
  const args = ["-c", "core.quotepath=false", "ls-files", "-z", "--", ...patterns];
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new SyncError(`git ls-files failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SyncError(`git ls-files exited ${result.status}: ${result.stderr}`);
  }
  const parts = result.stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  const unique = Array.from(new Set(parts.map(toPosix)));
  return applyExclude(unique, excludePatterns);
}

/** `oldPath -> [{ target, type: "R"|"C" }]`, from renames/copies since the last commit. Empty (never throws) when there is no HEAD yet or git errors. */
function detectRenames(repoRoot) {
  const map = new Map();
  const result = spawnSync("git", ["diff", "--name-status", "-M", "-C", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return map;
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    const status = parts[0];
    if (!status || (status[0] !== "R" && status[0] !== "C")) continue;
    const oldPath = parts[1];
    const newPath = parts[2];
    if (!oldPath || !newPath) continue;
    const arr = map.get(oldPath) ?? [];
    arr.push({ target: newPath, type: status[0] });
    map.set(oldPath, arr);
  }
  return map;
}

function layerFor(layers, modulePath) {
  for (const [name, members] of layers) {
    if (members.includes(modulePath)) return name;
  }
  return UNCATEGORIZED;
}

// ---------------------------------------------------------------------------
// Role / exports extraction
// ---------------------------------------------------------------------------

function escapePipe(text) {
  return text.replace(/\|/gu, "\\|");
}

/** Joins the leading `/** ... *\/` header (past an optional shebang) into one whitespace-normalized string. */
function extractCommentBlock(text) {
  const lines = text.split(/\r\n|\n/u);
  let i = 0;
  if (lines[0] && lines[0].startsWith("#!")) i = 1;
  if (!lines[i] || !lines[i].trim().startsWith("/**")) return "";
  const collected = [];
  const first = lines[i]
    .trim()
    .replace(/^\/\*\*/u, "")
    .trim();
  if (first) collected.push(first);
  for (i++; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const closeIdx = trimmed.indexOf("*/");
    if (closeIdx !== -1) {
      const before = trimmed
        .slice(0, closeIdx)
        .replace(/^\*\s?/u, "")
        .trim();
      if (before) collected.push(before);
      break;
    }
    collected.push(trimmed.replace(/^\*\s?/u, ""));
  }
  return collected.join(" ").replace(/\s+/gu, " ").trim();
}

/** First sentence of a joined comment, cut at the first `.` that ends a word (not a decimal or an extension like `*.md`), capped at 120 chars, no trailing period. */
function sentenceFromComment(joined) {
  const match = /\.(?=\s|$)/u.exec(joined);
  let sentence = match ? joined.slice(0, match.index) : joined;
  sentence = sentence.trim();
  if (sentence.length > 120) sentence = sentence.slice(0, 120).trim();
  if (sentence.endsWith(".")) sentence = sentence.slice(0, -1);
  return sentence;
}

function computeExtractedRole(fileText, layer, modulePath) {
  const comment = extractCommentBlock(fileText);
  if (comment) {
    const sentence = sentenceFromComment(comment);
    if (sentence) return escapePipe(sentence);
  }
  const base = basename(modulePath).replace(/\.tsx?$/u, "");
  return escapePipe(`${layer} module: ${base}`);
}

function extractExports(fileText) {
  const re = /^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gmu;
  const names = [];
  let match = re.exec(fileText);
  while (match && names.length < 5) {
    names.push(match[1]);
    match = re.exec(fileText);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Table rendering / parsing
// ---------------------------------------------------------------------------

function bytewiseCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function compareRows(layers) {
  const order = new Map(layers.map(([name], index) => [name, index]));
  const uncatIndex = layers.length;
  return (a, b) => {
    const oa = order.has(a.layer) ? order.get(a.layer) : uncatIndex;
    const ob = order.has(b.layer) ? order.get(b.layer) : uncatIndex;
    if (oa !== ob) return oa - ob;
    return bytewiseCompare(a.module, b.module);
  };
}

function renderTable(rows, eol) {
  const lines = ["| Module | Layer | Role | Key exports |", "| --- | --- | --- | --- |"];
  for (const r of rows) {
    const exports = r.exports.length > 0 ? r.exports.join(", ") : "—";
    lines.push(`| \`${r.module}\` | ${r.layer} | ${r.role} | ${exports} |`);
  }
  return lines.join(eol);
}

/** Splits a markdown table row on unescaped `|`, unescaping `\|` back to `|`, dropping the leading/trailing empty cells the outer pipes produce. */
function parseRowLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function parseTable(blockText) {
  const rows = [];
  for (const line of blockText.split(/\r\n|\n/u)) {
    const cells = parseRowLine(line);
    if (!cells || cells.length < 4) continue;
    if (cells[0] === "Module") continue;
    if (/^:?-{2,}:?$/u.test(cells[0])) continue;
    rows.push({ module: cells[0].replace(/^`|`$/gu, ""), layer: cells[1], role: cells[2], exports: cells[3] });
  }
  return rows;
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/gu) ?? []).length;
  return crlf > lfOnly ? "\r\n" : "\n";
}

/** Locates the marker pair, requiring exactly one of each, START before END. Throws `SyncError` otherwise. */
function locateMarkers(text) {
  const startIdx = text.indexOf(START_MARKER);
  const startLast = text.lastIndexOf(START_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  const endLast = text.lastIndexOf(END_MARKER);
  if (startIdx === -1) throw new SyncError(`Missing ${START_MARKER} marker`);
  if (endIdx === -1) throw new SyncError(`Missing ${END_MARKER} marker`);
  if (startIdx !== startLast) throw new SyncError(`Duplicate ${START_MARKER} marker`);
  if (endIdx !== endLast) throw new SyncError(`Duplicate ${END_MARKER} marker`);
  if (endIdx < startIdx) throw new SyncError(`${END_MARKER} marker precedes ${START_MARKER} marker`);
  return { startIdx, endIdx };
}

/** Replaces only the bytes strictly between the markers; everything before and including START, and from END onward, is preserved byte-exactly. */
function spliceMarkers(docText, { startIdx, endIdx }, tableText, eol) {
  const before = docText.slice(0, startIdx + START_MARKER.length);
  const after = docText.slice(endIdx);
  return `${before}${eol}${eol}${tableText}${eol}${eol}${after}`;
}

// ---------------------------------------------------------------------------
// Curated-role preservation
// ---------------------------------------------------------------------------

function pushOrigin(map, target, oldPath, role) {
  const arr = map.get(target) ?? [];
  arr.push({ oldPath, role });
  map.set(target, arr);
}

/**
 * Resolves curated rows whose path is no longer discovered: rekeys single renames, duplicates
 * (with a `(split from <old path>)` suffix) when one old path has multiple rename/copy targets, and
 * merges (keeping the longest Role) when multiple old paths land on the same target. Returns the
 * resolved `path -> role` map plus a flat, never-silent event log.
 */
function resolveCuratedMigrations(curatedGone, renameMap, discoveredSet) {
  const events = [];
  const targetOrigins = new Map();
  for (const c of curatedGone) {
    const targets = (renameMap.get(c.path) ?? []).filter((t) => discoveredSet.has(t.target));
    if (targets.length === 0) {
      events.push({ path: c.path, message: `${c.path}: curated Role dropped (module removed, no rename or copy detected)` });
    } else if (targets.length === 1) {
      pushOrigin(targetOrigins, targets[0].target, c.path, c.role);
    } else {
      const targetPaths = targets.map((t) => t.target);
      for (const t of targets) {
        pushOrigin(targetOrigins, t.target, c.path, `${c.role} (split from ${c.path})`);
      }
      events.push({ path: c.path, message: `${c.path}: curated Role duplicated to ${targetPaths.join(", ")} (split)` });
    }
  }

  const curatedRoles = new Map();
  for (const [target, origins] of targetOrigins) {
    const distinctOld = new Set(origins.map((o) => o.oldPath));
    if (distinctOld.size === 1) {
      curatedRoles.set(target, origins[0].role);
      continue;
    }
    let longest = origins[0];
    for (const o of origins) if (o.role.length > longest.role.length) longest = o;
    curatedRoles.set(target, longest.role);
    const discarded = origins.filter((o) => o !== longest).map((o) => `${o.oldPath} ("${o.role}")`);
    events.push({
      path: target,
      message: `${target}: merged curated Role from ${origins.map((o) => o.oldPath).join(", ")}, kept longest (discarded: ${discarded.join("; ")})`,
    });
  }
  return { curatedRoles, events };
}

// ---------------------------------------------------------------------------
// Core sync
// ---------------------------------------------------------------------------

/** Runs the full compute-and-optionally-write pass. Never throws for expected failure modes -- returns `exitCode` 2 for config/usage/marker errors instead. */
function runSync(repoRoot, { mode, format, strictCurated }) {
  let config;
  try {
    ensureGitRepo(repoRoot);
    config = loadConfig(repoRoot);
  } catch (error) {
    return { exitCode: 2, stderr: [error.message], changed: false, jsonPayload: null };
  }

  const docPath = join(repoRoot, config.doc);
  if (!existsSync(docPath)) {
    return { exitCode: 2, stderr: [`Doc not found: ${docPath}`], changed: false, jsonPayload: null };
  }

  let discovered;
  let markers;
  const docTextOriginal = readFileSync(docPath, "utf8");
  try {
    discovered = listComponents(repoRoot, config.patterns, config.exclude);
    markers = locateMarkers(docTextOriginal);
  } catch (error) {
    return { exitCode: 2, stderr: [error.message], changed: false, jsonPayload: null };
  }

  const eol = detectEol(docTextOriginal);
  const existingBlock = docTextOriginal.slice(markers.startIdx + START_MARKER.length, markers.endIdx);
  const existingRows = parseTable(existingBlock);
  const existingMap = new Map(existingRows.map((r) => [r.module, r]));
  const discoveredSet = new Set(discovered);

  const roleCache = new Map();
  const freshRole = (p) => {
    if (!roleCache.has(p)) {
      const text = readFileSync(join(repoRoot, p), "utf8");
      roleCache.set(p, computeExtractedRole(text, layerFor(config.layers, p), p));
    }
    return roleCache.get(p);
  };

  const curatedGone = [];
  const curatedRoles = new Map();
  for (const [p, row] of existingMap) {
    if (discoveredSet.has(p)) {
      if (row.role !== freshRole(p)) curatedRoles.set(p, row.role);
    } else {
      curatedGone.push({ path: p, role: row.role });
    }
  }

  const renameMap = detectRenames(repoRoot);
  const { curatedRoles: migrated, events } = resolveCuratedMigrations(curatedGone, renameMap, discoveredSet);
  for (const [target, role] of migrated) curatedRoles.set(target, role);

  const rows = [];
  const uncategorizedPaths = [];
  for (const p of discovered) {
    const layer = layerFor(config.layers, p);
    if (layer === UNCATEGORIZED) uncategorizedPaths.push(p);
    const role = curatedRoles.has(p) ? curatedRoles.get(p) : freshRole(p);
    const text = readFileSync(join(repoRoot, p), "utf8");
    rows.push({ module: p, layer, role, exports: extractExports(text) });
  }
  rows.sort(compareRows(config.layers));

  const newTable = renderTable(rows, eol);
  const newDocText = spliceMarkers(docTextOriginal, markers, newTable, eol);
  const changed = newDocText !== docTextOriginal;

  const unmapped = discovered.filter((p) => !existingMap.has(p)).sort(bytewiseCompare);
  const obsolete = [...existingMap.keys()].filter((p) => !discoveredSet.has(p)).sort(bytewiseCompare);
  const uncategorized = uncategorizedPaths.slice().sort(bytewiseCompare);
  const sortedEvents = events.slice().sort((a, b) => bytewiseCompare(a.path, b.path));

  const stderr = [];
  if (mode === "check") {
    for (const p of unmapped) stderr.push(`error: ${p}: module not present in ${config.doc} component table (run npm run arch:write)`);
    for (const p of obsolete) stderr.push(`error: ${p}: entry in ${config.doc} but module no longer exists (run npm run arch:write)`);
    for (const e of sortedEvents) stderr.push(`warn: ${e.message}`);
    for (const p of uncategorized) stderr.push(`error: ${p}: matches no declared layer in ${CONFIG_FILE} (classified ${UNCATEGORIZED})`);
  } else if (mode === "write") {
    for (const e of sortedEvents) stderr.push(`warn: ${e.message}`);
    for (const p of uncategorized) stderr.push(`error: ${p}: matches no declared layer in ${CONFIG_FILE} (classified ${UNCATEGORIZED})`);
  }

  let exitCode;
  if (mode === "check") {
    exitCode = changed || uncategorized.length > 0 ? 1 : 0;
  } else {
    if (changed) writeFileSync(docPath, newDocText, "utf8");
    exitCode = strictCurated && events.length > 0 ? 1 : 0;
  }

  const jsonPayload = {
    status: changed ? "drift" : "ok",
    unmapped,
    obsolete,
    curated_at_risk: sortedEvents.map((e) => e.message).sort(bytewiseCompare),
    uncategorized,
  };

  return { exitCode, stderr, changed, jsonPayload };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "arch-sync-selftest-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function gitCommitAll(dir, message) {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message], { cwd: dir });
}

function writeConfig(dir, config) {
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

function writeSrc(dir, name, content) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", name), content, "utf8");
}

function baseDoc(eol) {
  return ["# Test Architecture", "", START_MARKER, END_MARKER, ""].join(eol);
}

function readDoc(dir, docName = "ARCHITECTURE.md") {
  return readFileSync(join(dir, docName), "utf8");
}

function selfTest() {
  const results = [];
  const check = (name, condition, detail) => {
    results.push({ name, pass: Boolean(condition), detail: condition ? "" : detail });
  };

  // Case 1: idempotency -- --write twice on an unchanged tree is byte-identical.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/**\n * Alpha module role sentence.\n */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      const first = runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const textFirst = readDoc(dir);
      const second = runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const textSecond = readDoc(dir);
      check("Case 1: --write twice is byte-identical", first.exitCode === 0 && second.exitCode === 0 && textFirst === textSecond, `first=${first.exitCode} second=${second.exitCode} equal=${textFirst === textSecond}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 2: missing marker pair -> exit 2.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), "# No markers here\n", "utf8");
      gitCommitAll(dir, "init");
      const result = runSync(dir, { mode: "check", format: "text", strictCurated: false });
      check("Case 2: missing marker -> exit 2", result.exitCode === 2, `exitCode=${result.exitCode}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 3: duplicated marker -> exit 2.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      const doc = ["# Doc", "", START_MARKER, END_MARKER, "", START_MARKER, END_MARKER, ""].join("\n");
      writeFileSync(join(dir, "ARCHITECTURE.md"), doc, "utf8");
      gitCommitAll(dir, "init");
      const result = runSync(dir, { mode: "check", format: "text", strictCurated: false });
      check("Case 3: duplicated marker -> exit 2", result.exitCode === 2, `exitCode=${result.exitCode}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 4: inverted markers (END before START) -> exit 2.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      const doc = ["# Doc", "", END_MARKER, START_MARKER, ""].join("\n");
      writeFileSync(join(dir, "ARCHITECTURE.md"), doc, "utf8");
      gitCommitAll(dir, "init");
      const result = runSync(dir, { mode: "check", format: "text", strictCurated: false });
      check("Case 4: inverted markers -> exit 2", result.exitCode === 2, `exitCode=${result.exitCode}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 5: CRLF preservation.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\r\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      const hasCRLF = text.includes("\r\n");
      const hasBareLF = /(?<!\r)\n/u.test(text);
      check("Case 5: CRLF preserved, no bare LF introduced", hasCRLF && !hasBareLF, `hasCRLF=${hasCRLF} hasBareLF=${hasBareLF}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 6: trailing-newline preservation (content after END marker untouched).
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      const doc = `# Doc\n\n${START_MARKER}\n${END_MARKER}\n\n## Trailer\nNo trailing newline here.`;
      writeFileSync(join(dir, "ARCHITECTURE.md"), doc, "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      check("Case 6: bytes after END marker preserved exactly", text.endsWith("No trailing newline here."), JSON.stringify(text.slice(-40)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 7: bytewise sort stability (uppercase sorts before lowercase, unlike locale collation).
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "Zeta.ts", "/** Zeta. */\nexport function zeta() {}\n");
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, {
        doc: "ARCHITECTURE.md",
        patterns: ["src/*.ts"],
        layers: [["Core", ["src/Zeta.ts", "src/alpha.ts"]]],
        exclude: [],
      });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      check("Case 7: bytewise sort puts src/Zeta.ts before src/alpha.ts", text.indexOf("src/Zeta.ts") < text.indexOf("src/alpha.ts"), text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 8: curated Role survives a write.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      let text = readDoc(dir);
      text = text.replace(/\| Alpha \|/u, "| Hand-curated prose. |");
      writeFileSync(join(dir, "ARCHITECTURE.md"), text, "utf8");
      gitCommitAll(dir, "curate");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const after = readDoc(dir);
      check("Case 8: curated Role preserved verbatim across --write", after.includes("Hand-curated prose."), after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 9: rename re-keys a curated row.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "old.ts", "/** Old module. */\nexport function old() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/old.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      let text = readDoc(dir);
      text = text.replace(/\| Old module \|/u, "| CURATED ROLE TEXT |");
      writeFileSync(join(dir, "ARCHITECTURE.md"), text, "utf8");
      gitCommitAll(dir, "curate");
      const oldContent = readFileSync(join(dir, "src", "old.ts"), "utf8");
      rmSync(join(dir, "src", "old.ts"));
      writeSrc(dir, "new.ts", oldContent);
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/new.ts"]]], exclude: [] });
      // git ls-files reports the index, not the raw working tree, so the deletion/addition must be
      // staged (not committed) before discovery sees it -- otherwise old.ts still looks tracked.
      spawnSync("git", ["add", "-A"], { cwd: dir });
      const write = runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const after = readDoc(dir);
      const rekeyed = /new\.ts`[^\n]*CURATED ROLE TEXT/u.test(after);
      check("Case 9: rename re-keys curated Role to the new path", rekeyed, `stderr=${write.stderr.join(" | ")}\n${after}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 10: split duplicates a curated Role to every child.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "old.ts", "/** Old module. */\nexport function old() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/old.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      let text = readDoc(dir);
      text = text.replace(/\| Old module \|/u, "| CURATED SPLIT TEXT |");
      writeFileSync(join(dir, "ARCHITECTURE.md"), text, "utf8");
      gitCommitAll(dir, "curate");
      const oldContent = readFileSync(join(dir, "src", "old.ts"), "utf8");
      rmSync(join(dir, "src", "old.ts"));
      writeSrc(dir, "new1.ts", oldContent);
      writeSrc(dir, "new2.ts", oldContent);
      writeConfig(dir, {
        doc: "ARCHITECTURE.md",
        patterns: ["src/*.ts"],
        layers: [["Core", ["src/new1.ts", "src/new2.ts"]]],
        exclude: [],
      });
      spawnSync("git", ["add", "-A"], { cwd: dir });
      const write = runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const after = readDoc(dir);
      const both = /new1\.ts`[^\n]*CURATED SPLIT TEXT \(split from src\/old\.ts\)/u.test(after)
        && /new2\.ts`[^\n]*CURATED SPLIT TEXT \(split from src\/old\.ts\)/u.test(after);
      check("Case 10: split duplicates curated Role to both children", both, `stderr=${write.stderr.join(" | ")}\n${after}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 11: layer order follows config declaration order, not alphabetical.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "zeta.ts", "/** Zeta. */\nexport function zeta() {}\n");
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, {
        doc: "ARCHITECTURE.md",
        patterns: ["src/*.ts"],
        layers: [
          ["Zeta Layer", ["src/zeta.ts"]],
          ["Alpha Layer", ["src/alpha.ts"]],
        ],
        exclude: [],
      });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      check("Case 11: declared layer order wins over alphabetical", text.indexOf("Zeta Layer") < text.indexOf("Alpha Layer"), text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 12: an Uncategorized member is reported as drift.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "orphan.ts", "/** Orphan. */\nexport function orphan() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", []]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      const result = runSync(dir, { mode: "check", format: "json", strictCurated: false });
      const flagged = result.exitCode === 1 && result.jsonPayload.uncategorized.includes("src/orphan.ts");
      check("Case 12: Uncategorized member fails --check", flagged, JSON.stringify(result.jsonPayload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 13: Role truncation at 120 chars.
  {
    const dir = makeTempRepo();
    try {
      const longSentence = "A".repeat(200);
      writeSrc(dir, "long.ts", `/** ${longSentence} without an early period */\nexport function longFn() {}\n`);
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/long.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      const rowMatch = /\| `src\/long\.ts` \| Core \| (.*?) \| [^|]*\|/u.exec(text);
      const role = rowMatch ? rowMatch[1] : "";
      check("Case 13: Role capped at 120 chars", role.length > 0 && role.length <= 120, `len=${role.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 14: pipe escaping in a Role.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "piped.ts", "/** Reads a `key|value` pair from stdin. */\nexport function piped() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/piped.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const text = readDoc(dir);
      const rowLine = text.split("\n").find((l) => l.includes("src/piped.ts"));
      const escaped = Boolean(rowLine) && rowLine.includes("key\\|value") && parseRowLine(rowLine)?.length === 4;
      check("Case 14: pipe in Role is escaped and row still parses to 4 cells", escaped, rowLine ?? "<no row>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Case 15: exit 0 on a synchronized tree.
  {
    const dir = makeTempRepo();
    try {
      writeSrc(dir, "alpha.ts", "/** Alpha. */\nexport function alpha() {}\n");
      writeConfig(dir, { doc: "ARCHITECTURE.md", patterns: ["src/*.ts"], layers: [["Core", ["src/alpha.ts"]]], exclude: [] });
      writeFileSync(join(dir, "ARCHITECTURE.md"), baseDoc("\n"), "utf8");
      gitCommitAll(dir, "init");
      runSync(dir, { mode: "write", format: "text", strictCurated: false });
      const result = runSync(dir, { mode: "check", format: "text", strictCurated: false });
      check("Case 15: synchronized tree exits 0 with empty stderr", result.exitCode === 0 && result.stderr.length === 0, `exitCode=${result.exitCode} stderr=${JSON.stringify(result.stderr)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.pass);
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}${r.pass ? "" : ` -- ${r.detail}`}`);
  lines.push(`${results.length - failed.length}/${results.length} passed`);
  return { pass: failed.length === 0, summary: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mode: "check", format: "text", strictCurated: false, selfTest: false };
  for (const arg of argv) {
    if (arg === "--check") opts.mode = "check";
    else if (arg === "--write") opts.mode = "write";
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--strict-curated") opts.strictCurated = true;
    else if (arg === "--format=json") opts.format = "json";
    else if (arg === "--format=text") opts.format = "text";
    else throw new SyncError(`Unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  const repoRoot = process.cwd();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.selfTest) {
    const result = selfTest();
    process.stdout.write(`${result.summary}\n`);
    process.exitCode = result.pass ? 0 : 1;
    return;
  }

  const out = runSync(repoRoot, opts);
  for (const line of out.stderr) process.stderr.write(`${line}\n`);
  if (opts.mode === "check" && opts.format === "json") {
    process.stdout.write(`${JSON.stringify(out.jsonPayload)}\n`);
  }
  process.exitCode = out.exitCode;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
