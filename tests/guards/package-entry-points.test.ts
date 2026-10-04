/** Guard test: package.json's entry points must name files the build produces, and the CLI bundle must not double as a library `main` (importing it runs the CLI). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { main?: string; exports?: unknown; bin?: Record<string, string> };
const buildConfig = readFileSync(join(REPO_ROOT, "esbuild.config.mjs"), "utf8");
const outputs = [...buildConfig.matchAll(/outfile:\s*"([^"]+)"/gu)].map((match) => match[1] ?? "");
const normalize = (path: string): string => path.replace(/^\.\//u, "");

describe("package entry points", () => {
  it("every bin target is a file the build produces", () => {
    expect(outputs.length).toBeGreaterThan(0);
    for (const [name, target] of Object.entries(pkg.bin ?? {})) {
      expect(outputs, `bin "${name}" -> ${target}`).toContain(normalize(target));
    }
  });

  it("main, when present, is a built file that is not a bin (the CLI bundle runs on import)", () => {
    if (pkg.main === undefined) {
      return;
    }
    expect(outputs, `main ${pkg.main}`).toContain(normalize(pkg.main));
    const binTargets = Object.values(pkg.bin ?? {}).map(normalize);
    expect(binTargets, `main ${pkg.main} is the CLI bundle; importing it would run the CLI`).not.toContain(normalize(pkg.main));
  });

  it("exports, when present, only names built files", () => {
    if (pkg.exports === undefined) {
      return;
    }
    const targets = [...JSON.stringify(pkg.exports).matchAll(/"(\.\/[^"]+)"/gu)].map((match) => normalize(match[1] ?? ""));
    for (const target of targets) {
      expect(outputs, `exports target ${target}`).toContain(target);
    }
  });
});
