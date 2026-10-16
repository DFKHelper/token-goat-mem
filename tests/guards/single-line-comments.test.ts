/** Guard that every comment in the tracked sources stays on one line and no doc comment is left stranded on another, by calling `runCommentCheck` and `runSelfTest` from `scripts/single-line-comments.mjs` in-process -- the engine `npm run comments:check` and `npm run comments:write` invoke, with no node spawn and so no per-test timeout override. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readIndexPaths, runCommentCheck, runSelfTest, trackedSources } from "../../scripts/single-line-comments.mjs";

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
