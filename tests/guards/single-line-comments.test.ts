/** Guard that every comment in the tracked sources stays on one line and no doc comment is left stranded on another, by calling `runCommentCheck` and `runSelfTest` from `scripts/single-line-comments.mjs` in-process -- the engine `npm run comments:check` and `npm run comments:write` invoke, with no node spawn and so no per-test timeout override. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCommentCheck, runSelfTest } from "../../scripts/single-line-comments.mjs";

describe("comments stay single-line", () => {
  it("no tracked source has a multi-line or stacked doc comment", () => {
    const result = runCommentCheck({ write: false });
    expect(result.exitCode, `Comment shape drift. Run 'npm run comments:write'.\n${result.output.join("\n")}`).toBe(0);
  });

  it("the comment engine's own self-test passes", () => {
    const result = runSelfTest();
    expect(result.pass, `Comment engine self-test failed.\n${result.failures.join("\n")}\n${result.summary}`).toBe(true);
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
