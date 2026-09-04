/**
 * Unit tests for `src/facets.ts`.
 *
 * The negative half matters as much as the positive half. An entity list that also catches ordinary
 * prose words is not a second retrieval signal -- it is a noisier duplicate of the BM25 index, with
 * every prose word stored twice and every `--entity` query answered by facts that merely contain an
 * English sentence. So each recognized shape is pinned, and so is the plain-prose case that must
 * produce nothing at all.
 */
import { describe, expect, it } from "vitest";

import { extractFacets, normalizeTermKey, MAX_ENTITIES_PER_FACT, MAX_TOPICS_PER_FACT } from "../src/facets.js";
import { tokenize } from "../src/retrieval.js";

describe("extractFacets: entity shapes", () => {
  const recognized: ReadonlyArray<readonly [string, string, string]> = [
    ["path with a forward slash", "the ranking lives in src/retrieval.ts today", "src/retrieval.ts"],
    ["path with three segments", "CI is defined by .github/workflows/ci.yml", ".github/workflows/ci.yml"],
    ["path with a backslash", "open src\\storage.ts to see the schema", "src\\storage.ts"],
    ["dotted filename", "the version comes from package.json", "package.json"],
    ["bare filename with extension", "retrieval.ts owns the stemmer", "retrieval.ts"],
    ["dotted identifier chain", "read foo.bar.baz off the config", "foo.bar.baz"],
    ["snake_case", "facts carry a scope_root column", "scope_root"],
    ["SCREAMING_SNAKE_CASE", "raise AGGRESSIVE_RECALL_BOOST if recall is thin", "AGGRESSIVE_RECALL_BOOST"],
    ["camelCase", "packEmbedding writes the blob", "packEmbedding"],
    ["PascalCase with an internal case change", "we chose PostgreSQL over sqlite here", "PostgreSQL"],
    ["long CLI flag", "token-goat calls mem with --hint-format", "--hint-format"],
    ["short CLI flag", "pass -v to see the version", "-v"],
    ["v-prefixed version", "pinned at v2.1.0 for now", "v2.1.0"],
    ["bare semver", "the bug landed in 1.2.3", "1.2.3"],
    ["caret range", "the manifest asks for ^4.4.3", "^4.4.3"],
    ["scoped npm package", "depends on @scope/package at runtime", "@scope/package"],
  ];

  for (const [label, text, expected] of recognized) {
    it(`preserves a ${label} verbatim`, () => {
      expect(extractFacets(text).entities).toContain(expected);
    });
  }

  it("keeps an entity's original case and punctuation, which is the whole point", () => {
    // BM25 would reduce all three to `postgresql`/`src`+`retriev`+`ts`/`aggress`+`recall`+`boost`.
    const { entities } = extractFacets("PostgreSQL is configured in src/retrieval.ts via AGGRESSIVE_RECALL_BOOST");
    expect(entities).toEqual(["PostgreSQL", "src/retrieval.ts", "AGGRESSIVE_RECALL_BOOST"]);
  });

  it("strips sentence punctuation that trails an entity", () => {
    expect(extractFacets("the ranking lives in src/retrieval.ts.").entities).toEqual(["src/retrieval.ts"]);
    expect(extractFacets("we pinned it to v2.1.0, then moved on").entities).toEqual(["v2.1.0"]);
  });

  it("finds an entity inside backticks, quotes, and parentheses", () => {
    expect(extractFacets("run `mem recall --hint-format` (see docs)").entities).toEqual(["--hint-format"]);
  });
});

describe("extractFacets: what must NOT become an entity", () => {
  it("yields zero entities for a plain English sentence", () => {
    const text = "The team decided that the deployment process should always be reviewed by another person before it runs.";
    expect(extractFacets(text).entities).toEqual([]);
  });

  it("does not treat a capitalized sentence opener or an acronym as an identifier", () => {
    // Both lack an internal lower-to-upper transition; a "contains a capital" rule would make every
    // sentence's first word an entity and drown the index.
    expect(extractFacets("Deployments go out over HTTP on Tuesday").entities).toEqual([]);
  });

  it("does not treat prose slash idioms as paths", () => {
    expect(extractFacets("this applies to read/write and to any and/or case").entities).toEqual([]);
  });

  it("does not treat prose abbreviations as dotted identifiers", () => {
    expect(extractFacets("prefer the shorter form, e.g. when writing docs, i.e. always").entities).toEqual([]);
  });

  it("does not treat a hyphenated English word as a CLI flag", () => {
    expect(extractFacets("this is a well-known trade-off").entities).toEqual([]);
  });
});

describe("extractFacets: determinism, de-duplication, and bounds", () => {
  it("returns the same lists in the same order for the same input", () => {
    const text = "src/cli.ts calls src/storage.ts, which calls src/cli.ts again";
    expect(extractFacets(text)).toEqual(extractFacets(text));
    expect(extractFacets(text).entities).toEqual(["src/cli.ts", "src/storage.ts"]);
  });

  it("de-duplicates two spellings of one entity onto the first occurrence", () => {
    expect(extractFacets("PostgreSQL, or postgresql if you prefer").entities).toEqual(["PostgreSQL"]);
  });

  it("bounds both lists so one pathological capture cannot write thousands of rows", () => {
    // A pasted lockfile is the realistic shape: hundreds of distinct dotted identifiers and words.
    const pathological = Array.from({ length: 2000 }, (_, index) => `pkg${index}.mod${index}.js word${index}`).join(" ");
    const { entities, topics } = extractFacets(pathological);
    expect(entities).toHaveLength(MAX_ENTITIES_PER_FACT);
    expect(topics).toHaveLength(MAX_TOPICS_PER_FACT);
  });

  it("ignores a single chunk too long to be anything a human typed as an identifier", () => {
    const blob = `x${"A1b2".repeat(100)}/y`;
    expect(extractFacets(`the payload was ${blob}`).entities).toEqual([]);
  });

  it("survives empty and whitespace-only text without inventing terms", () => {
    expect(extractFacets("")).toEqual({ entities: [], topics: [] });
    expect(extractFacets("   \n\t ")).toEqual({ entities: [], topics: [] });
  });
});

describe("extractFacets: topics are BM25's own terms", () => {
  it("is exactly tokenize's output, de-duplicated in order", () => {
    const text = "the deployment uses blue-green deployments for the rollout";
    const expected: string[] = [];
    for (const token of tokenize(text)) {
      if (!expected.includes(token)) {
        expected.push(token);
      }
    }
    expect(extractFacets(text).topics).toEqual(expected);
  });

  it("drops stopwords and stems, so it cannot answer the query entities exist for", () => {
    const { topics } = extractFacets("the ranking lives in src/retrieval.ts");
    expect(topics).not.toContain("src/retrieval.ts");
    expect(topics).toContain("retriev");
  });
});

describe("normalizeTermKey", () => {
  it("trims and lowercases, so lookup is case-insensitive", () => {
    expect(normalizeTermKey("  PostgreSQL ")).toBe("postgresql");
    expect(normalizeTermKey("SRC/Retrieval.TS")).toBe("src/retrieval.ts");
  });
});
