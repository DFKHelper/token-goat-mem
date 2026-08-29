/**
 * Source-level guard that every declared runtime dependency is actually reachable from `src/`.
 *
 * `dependencies` and `optionalDependencies` are the only part of package.json a user pays for: they
 * are installed on every `npm install -g token-goat-mem`. A package listed there and imported
 * nowhere is pure install weight, and nothing in a green suite notices -- `zod@^4.4.3` sat in
 * `dependencies` unimported by a single line, and `sqlite-vec` in `optionalDependencies` referenced
 * only by a comment, through six releases.
 *
 * Deliberately source-level and deliberately one-directional. It cannot catch the opposite error (an
 * import with no declaration), because esbuild's `external` list, not this file, decides what has to
 * be resolvable at runtime -- and a missing declaration fails loudly at install time anyway, where an
 * unused one fails silently forever.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/** Concatenated text of every `.ts` file directly under `src/`. */
function srcText(): string {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(SRC_DIR, name), "utf8"))
    .join("\n");
}

/** Every module specifier `src/` imports or requires, bare package names only. */
function importedPackages(): Set<string> {
  const text = srcText();
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      // Relative paths are internal; `node:` builtins are not declared dependencies.
      if (specifier.startsWith(".") || specifier.startsWith("node:")) {
        continue;
      }
      // Reduce a subpath import (`pkg/sub`, `@scope/pkg/sub`) to its package name.
      const parts = specifier.split("/");
      specifiers.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? ""));
    }
  }
  return specifiers;
}

describe("declared runtime dependencies are actually used", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as PackageManifest;
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];

  it("declares at least one runtime dependency, so an empty manifest cannot vacuously pass", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)("%s is imported by src/", (name) => {
    expect(importedPackages().has(name)).toBe(true);
  });
});
