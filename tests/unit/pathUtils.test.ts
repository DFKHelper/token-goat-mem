import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideOrEqual } from "../../src/pathUtils.js";

describe("isInsideOrEqual", () => {
  it("returns true when child equals root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    expect(isInsideOrEqual(root, root)).toBe(true);
  });

  it("returns true when child is a direct child of root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const child = root + sep + "file.txt";
    expect(isInsideOrEqual(child, root)).toBe(true);
  });

  it("returns true when child is a descendant of root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const child = root + sep + "packages" + sep + "api" + sep + "src" + sep + "index.ts";
    expect(isInsideOrEqual(child, root)).toBe(true);
  });

  it("returns true when child is under filesystem root", () => {
    const fsRoot = process.platform === "win32" ? "C:\\" : "/";
    const childPath = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
    expect(isInsideOrEqual(childPath, fsRoot)).toBe(true);
  });

  it("returns false when child is outside root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const other = process.platform === "win32" ? "C:\\other" : "/other";
    expect(isInsideOrEqual(other, root)).toBe(false);
  });

  it("returns false when child is a sibling of root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const sibling = process.platform === "win32" ? "C:\\repo2" : "/repo2";
    expect(isInsideOrEqual(sibling, root)).toBe(false);
  });

  it("handles root paths with trailing separators on root", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const rootWithSep = root + sep;
    const child = root + sep + "file.txt";
    expect(isInsideOrEqual(child, rootWithSep)).toBe(true);
  });

  it("equals when both have same trailing separator", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const rootWithSep = root + sep;
    expect(isInsideOrEqual(rootWithSep, rootWithSep)).toBe(true);
  });
});
