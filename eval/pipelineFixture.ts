/**
 * Filesystem + SQLite scaffolding for the `"pipeline"` configuration (item 4): drives the real
 * `retrieve()` (src/retrieval.ts) instead of `rank.ts`'s reduced reimplementation.
 *
 * `retrieve()` takes facts as plain data and opens no database itself (its one-way dependency rule
 * -- see ARCHITECTURE.md), but it does need two things only a caller can supply: a filesystem its
 * anchors can resolve against, and the entity/graph signals `src/cli.ts` precomputes for
 * `mem recall`. This module builds both, and maps `fixtures.ts`'s fake `PROJECT_ROOTS` paths onto
 * real temp directories so `RetrievalOptions.restrictToRoot` and anchor evaluation see a tree that
 * actually exists, rather than changing the fixture generator itself.
 *
 * The corpus passed to `evaluateConfig` (see `eval/run.ts`) stays the *original*, unmapped one for
 * every configuration including `"pipeline"` -- `evaluateConfig`'s own `noMatchNeverFiltered`
 * invariant check compares `Scenario.root` against `facts[].scopeRoot` directly, and both sides
 * have to agree on which vocabulary of roots (fake or real) they're using. Only inside this
 * module's `rankScenario` closure does a root-remapped view of the corpus exist, built once and
 * reused across every scenario.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGraphScoresForQuery } from "../src/factgraph.js";
import { retrieve, type RetrievalOptions } from "../src/retrieval.js";
import {
  createBufferedAnchorCacheStore,
  getEntityKeysByFact,
  getEntityOverlapForQuery,
  insertFact,
  openStorage,
  prefetchAnchorCache,
} from "../src/storage.js";
import { PROJECT_ROOTS, type EvalFact } from "./fixtures.js";
import type { RankScenario } from "./harness.js";
import type { RankedResult } from "./rank.js";

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Builds one fake project root's fixture tree: everything `fixtures.ts`'s `ANCHOR_TEMPLATES`
 * probes for (`package.json`, `src/index.ts`, a `*.config.*` file, `.eslintrc`), plus a git repo
 * with `src/index.ts` staged -- `git-tracked` reads `.git/index` directly, which needs a populated
 * index, not just a `.git` directory.
 */
function buildProjectRoot(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  writeFileSync(join(root, "src", "index.ts"), "export {};\n", "utf8");
  writeFileSync(join(root, "app.config.js"), "export default {};\n", "utf8");
  writeFileSync(join(root, ".eslintrc"), "{}\n", "utf8");
  runGit(["init", "-q"], root);
  runGit(["add", "src/index.ts"], root);
}

export interface FsFixture {
  /** Fake `PROJECT_ROOTS` path -> real, resolvable temp directory. */
  readonly rootMap: ReadonlyMap<string, string>;
  /** The temp directory everything above lives under, for the SQLite file to share. */
  readonly baseDir: string;
  /** Deletes the whole temp tree. Idempotent. */
  cleanup(): void;
}

/**
 * Creates one temp directory per `PROJECT_ROOTS` entry, each a resolvable fixture tree, and returns
 * the fake-root -> real-root mapping `buildPipelineContext` needs to make scope binding and anchor
 * evaluation see something real.
 */
export function buildFsFixture(): FsFixture {
  const baseDir = mkdtempSync(join(tmpdir(), "token-goat-mem-eval-"));
  const rootMap = new Map<string, string>();
  for (const fakeRoot of PROJECT_ROOTS) {
    const name = fakeRoot.split("/").pop();
    if (name === undefined || name.length === 0) {
      throw new Error(`buildFsFixture: could not derive a directory name from ${fakeRoot}`);
    }
    const realRoot = join(baseDir, "repos", name);
    buildProjectRoot(realRoot);
    rootMap.set(fakeRoot, realRoot);
  }
  return {
    rootMap,
    baseDir,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Returns a copy of `facts` with every project/path-scoped fact's `scopeRoot` rewritten through
 * `rootMap` -- the fixture generator itself is untouched (same ids, same `captured_at`, same
 * anchors), only this derived view points at real directories.
 */
function remapFactRoots(facts: readonly EvalFact[], rootMap: ReadonlyMap<string, string>): readonly EvalFact[] {
  return facts.map((fact) => {
    if (fact.scopeRoot === null || fact.scopeRoot === undefined) {
      return fact;
    }
    const mappedRoot: string = rootMap.get(fact.scopeRoot) ?? fact.scopeRoot;
    // `captureRoot` has to move with `scopeRoot`, not just alongside it: `anchorRootFor` evaluates a
    // `path` fact's anchor against `captureRoot` alone, so leaving it on the unresolvable fake path
    // pointed every path-scoped anchor at a directory that does not exist.
    const mappedCaptureRoot: string | null | undefined =
      typeof fact.captureRoot === "string" ? (rootMap.get(fact.captureRoot) ?? fact.captureRoot) : fact.captureRoot;
    return { ...fact, scopeRoot: mappedRoot, captureRoot: mappedCaptureRoot };
  });
}

export interface PipelineContext {
  /** Ranks one scenario by driving the real `retrieve()` -- see `eval/harness.ts`'s `RankScenario`. */
  readonly rankScenario: RankScenario;
  /** Closes the underlying SQLite connection. Call once, after every scenario has been ranked. */
  cleanup(): void;
}

/**
 * Opens a temp SQLite store at `dbPath`, inserts `facts` (the same, unmapped corpus every other
 * configuration ranks), and returns a `rankScenario` that mirrors `src/cli.ts`'s `mem recall`
 * wiring: `getEntityOverlapForQuery`/`getGraphScoresForQuery` recomputed per query,
 * `prefetchAnchorCache` + `createBufferedAnchorCacheStore` per root, `factEntityKeys` computed
 * once. `usefulness` is left out entirely (no recall history exists against a fixture that was
 * never actually recalled from) and `embeddingBackend` is omitted (BM25-only, no network).
 *
 * Facts are inserted unmapped on purpose: `getEntityKeysByFact`/`getEntityOverlapForQuery`/
 * `getGraphScoresForQuery` all key off `fact_terms` (text-derived), never `scope_root`, so the
 * database's own copy of the corpus never needs to know about the real filesystem at all -- only
 * the in-memory `pipelineFacts` handed to `retrieve()` below does.
 */
export function buildPipelineContext(dbPath: string, facts: readonly EvalFact[], rootMap: ReadonlyMap<string, string>, now: Date): PipelineContext {
  const db = openStorage(dbPath);
  for (const fact of facts) {
    insertFact(db, fact);
  }
  const factEntityKeys = getEntityKeysByFact(db);
  const pipelineFacts = remapFactRoots(facts, rootMap);

  const rankScenario: RankScenario = async (_facts, scenario): Promise<RankedResult[]> => {
    const root = rootMap.get(scenario.root) ?? scenario.root;
    const entityOverlap = getEntityOverlapForQuery(db, scenario.query);
    const graphScores = getGraphScoresForQuery(db, scenario.query, {}, entityOverlap);
    const anchorCacheStore = createBufferedAnchorCacheStore(prefetchAnchorCache(db, root));

    const options: RetrievalOptions = {
      query: scenario.query,
      root,
      restrictToRoot: true,
      hintFormat: false,
      now,
      anchorCacheStore,
      factEntityKeys,
      ...(entityOverlap.size > 0 ? { entityOverlap } : {}),
      ...(graphScores.size > 0 ? { graphScores } : {}),
    };
    const outcome = await retrieve(pipelineFacts, options);
    // `outcome.results[].fact` is the same object reference `retrieve` was handed (filtered/
    // spread, never rebuilt from scratch -- see `src/contradiction.ts`'s `resolveContradictions`),
    // so it still carries `EvalFact`'s `_template`/`_value`/`_isDuplicate` bookkeeping fields at
    // runtime even though `retrieve`'s own return type only promises the narrower `Fact`.
    return outcome.results.map((result) => ({ fact: result.fact as EvalFact, score: result.score, freshness: result.freshness }));
  };

  return {
    rankScenario,
    cleanup: (): void => {
      db.close();
    },
  };
}
