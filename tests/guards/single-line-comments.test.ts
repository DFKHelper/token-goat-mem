/** Guard that every comment in the tracked sources stays on one line and no doc comment is left stranded on another, by calling `runCommentCheck` and `runSelfTest` from `scripts/single-line-comments.mjs` in-process -- the engine `npm run comments:check` and `npm run comments:write` invoke, with no node spawn and so no per-test timeout override. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blockSpansLines, indexedPaths, joinComments, readIndexPaths, runCommentCheck, runSelfTest, trackedSources } from "../../scripts/single-line-comments.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface FakeEntry {
  readonly path: string;
  readonly stage?: number;
}

/** A git index file for `entries` in format version 2 or 4 (version 4 stores each path as a strip count plus a suffix), sealed with the SHA-1 trailer git writes. */
function buildIndex(version: 2 | 4, entries: readonly FakeEntry[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  let previous = "";
  for (const entry of entries) {
    const fixed = Buffer.alloc(62);
    fixed.writeUInt32BE(0o100644, 24);
    fixed.writeUInt16BE(((entry.stage ?? 0) << 12) | Math.min(entry.path.length, 0xfff), 60);
    if (version === 2) {
      const size = (62 + Buffer.byteLength(entry.path) + 8) & ~7;
      parts.push(Buffer.concat([fixed, Buffer.from(entry.path, "utf8"), Buffer.alloc(size - 62 - Buffer.byteLength(entry.path))]));
    } else {
      let shared = 0;
      while (shared < previous.length && shared < entry.path.length && previous[shared] === entry.path[shared]) {
        shared++;
      }
      parts.push(Buffer.concat([fixed, Buffer.from([Buffer.byteLength(previous.slice(shared))]), Buffer.from(entry.path.slice(shared), "utf8"), Buffer.alloc(1)]));
      previous = entry.path;
    }
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

describe("comments stay single-line", () => {
  it("no tracked source has a multi-line or stacked doc comment", () => {
    const result = runCommentCheck({ write: false });
    expect(result.exitCode, `Comment shape drift. Run 'npm run comments:write'.\n${result.output.join("\n")}`).toBe(0);
  });

  it("the comment engine's own self-test passes", () => {
    const result = runSelfTest();
    expect(result.pass, `Comment engine self-test failed.\n${result.failures.join("\n")}\n${result.summary}`).toBe(true);
  });

  it("lists the tracked sources of this repository from its index, not an empty or partial set", () => {
    const sources = trackedSources(REPO_ROOT);
    expect(sources.length, "the tracked listing is nearly empty").toBeGreaterThan(50);
    expect(sources).toContain("scripts/single-line-comments.mjs");
    expect(sources).toContain("tests/guards/single-line-comments.test.ts");
    expect(sources.filter((file) => file.startsWith("dist/") || !/\.(ts|mts|cts|js|mjs|cjs)$/.test(file)), "dist/ and non-source paths stay out").toEqual([]);
  });

  it("reads the paths out of a version 2 and a version 4 index, in index order", () => {
    const paths = ["a.ts", "dist/x.js", "src/b.mjs", "src/c.mjs", "src/déjà/ü.ts", "zz-notes.md"].map((path) => ({ path }));
    for (const version of [2, 4] as const) {
      expect(readIndexPaths(buildIndex(version, paths)), `version ${version}`).toEqual(paths.map((entry) => entry.path));
    }
  });

  it("refuses an index it cannot fully read, so the caller asks git", () => {
    const entries = [{ path: "a.ts" }, { path: "b.ts" }];
    const good = buildIndex(2, entries);
    const flipped = Buffer.from(good);
    const at = good.length - 30;
    flipped.writeUInt8((flipped.readUInt8(at) + 1) % 256, at);
    const futureVersion = Buffer.from(buildIndex(2, entries));
    futureVersion.writeUInt32BE(5, 4);
    expect(readIndexPaths(good), "the control index reads").toEqual(["a.ts", "b.ts"]);
    expect(readIndexPaths(flipped), "a checksum mismatch").toBeUndefined();
    expect(readIndexPaths(futureVersion), "a version this reader does not know").toBeUndefined();
    expect(readIndexPaths(buildIndex(2, [{ path: "a.ts", stage: 2 }])), "an unmerged entry").toBeUndefined();
    expect(readIndexPaths(Buffer.from("not an index")), "bytes that are not an index").toBeUndefined();
  });

  it("reads the index only when no git variable can make git list something else", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-index-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "index"), buildIndex(2, [{ path: "a.ts" }, { path: "b.md" }]));
      expect(indexedPaths(root, {}), "the control: a plain repository root reads").toEqual(["a.ts", "b.md"]);
      const variables = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"];
      for (const name of variables) {
        expect(indexedPaths(root, { [name]: "1" }), `${name} set: the caller must ask git`).toBeUndefined();
      }
      const config = join(root, ".git", "config");
      writeFileSync(config, "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
      expect(indexedPaths(root, {}), "a config with no work tree key reads").toEqual(["a.ts", "b.md"]);
      for (const body of ["[core]\n\tworktree = ../elsewhere\n", "[core]\n\tWorkTree=/x\n", "[include]\n\tpath = more\n"]) {
        writeFileSync(config, body);
        expect(indexedPaths(root, {}), `a config that could relocate the work tree: ${JSON.stringify(body)}`).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a line break inside a block comment exactly where the pattern it replaced did", () => {
    const pattern = /\/\*(?:[^*\n]|\*(?!\/))*\n/;
    const alphabet = ["/", "*", "\n", "a", " "];
    const inputs: string[] = [""];
    for (let from = 0, length = 1; length <= 6; length++) {
      const upto = inputs.length;
      for (let index = from; index < upto; index++) {
        for (const letter of alphabet) {
          inputs.push((inputs[index] as string) + letter);
        }
      }
      from = upto;
    }
    const disagreements = inputs.filter((text) => blockSpansLines(text) !== pattern.test(text));
    expect(disagreements.slice(0, 5).map((text) => JSON.stringify(text)), `${inputs.length} texts compared`).toEqual([]);
    expect(blockSpansLines("/* a\n b */"), "a wrapped block").toBe(true);
    expect(blockSpansLines("/* a */\n/* b */\n"), "closed blocks with breaks after them").toBe(false);
    expect(blockSpansLines("/*/\n"), "a slash right after the opener is not a closer").toBe(true);
  });

  it("scans a long text with many unclosed block openers without joining anything", () => {
    const text = "x=1;/*a".repeat(80_000);
    expect(blockSpansLines(text), "no line break anywhere").toBe(false);
    expect(joinComments(text, "long.ts"), "nothing to join").toEqual({ out: text, count: 0 });
    expect(blockSpansLines(text + "\n"), "one break after the last opener").toBe(true);
  });

  it("a two-line // comment in a scoped file is reported by name", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-comments-"));
    try {
      writeFileSync(join(root, "sample.ts"), "// first line\n// second line\nexport const x = 1;\n", "utf8");
      const result = runCommentCheck({ write: false, root, files: ["sample.ts"] });
      expect(result.exitCode, `Scoped check should flag the two-line comment.\n${result.output.join("\n")}`).toBe(1);
      expect(result.output.join("\n")).toContain("sample.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
