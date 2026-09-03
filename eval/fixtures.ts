/**
 * Deterministic synthetic fixture corpus for the retrieval eval harness (item 3).
 *
 * Generated from a seeded PRNG (`eval/prng.ts`) rather than hand-written, so re-running
 * `npm run eval` with the same `EVAL_SEED` reproduces the exact same corpus and scenario set --
 * no giant JSON blob to keep in sync with this file, and no run-to-run noise in the reported
 * precision/nDCG numbers.
 *
 * The corpus spans:
 *   - ~5 fake project roots ("scope=project" facts bind to one of them; "scope=path" facts bind to
 *     a file under one; "scope=global" facts bind to none).
 *   - all four `FactKind`s (`preference`, `decision`, `fact`, `correction`).
 *   - realistic developer-domain text: package managers, test runners, CI systems, formatters,
 *     linters, architecture decisions, deploy cadence, database choice, branch strategy, commit
 *     convention, code review policy.
 *   - deliberate exact duplicates (same subject/value/scope/root, different id and capture time).
 *   - deliberate contradictory pairs (same subject+scope+root, different value -- what
 *     `src/contradiction.ts` would key on).
 *   - a mix of anchored (non-null `anchor` string) and unanchored (`anchor: null`) variants.
 */

import { chance, mulberry32, pick, pickN } from "./prng.js";
import type { Fact, FactKind, FactScope } from "../src/types.js";

/** Default seed for `generateCorpus`/`generateScenarios` -- change only if the corpus itself should change. */
export const EVAL_SEED = 424242;

export const PROJECT_ROOTS = [
  "/fake/repos/webapp",
  "/fake/repos/api-service",
  "/fake/repos/mobile-app",
  "/fake/repos/infra-tools",
  "/fake/repos/data-pipeline",
] as const;

interface Template {
  readonly subject: string;
  readonly values: readonly string[];
  /** Builds fact text for this subject+value at the given kind. */
  readonly text: (value: string, kind: FactKind) => string;
  /** Kinds this template can be captured as; the generator samples among these. */
  readonly kinds: readonly FactKind[];
}

const TEMPLATES: readonly Template[] = [
  {
    subject: "package_manager",
    values: ["npm", "pnpm", "yarn", "bun"],
    kinds: ["fact", "preference", "correction"],
    text: (v, k) =>
      k === "preference"
        ? `prefers ${v} over the other package managers`
        : k === "correction"
          ? `correction: the package manager was migrated to ${v}`
          : `the project's package manager is ${v}`,
  },
  {
    subject: "test_runner",
    values: ["vitest", "jest", "mocha", "ava"],
    kinds: ["fact", "preference"],
    text: (v, k) => (k === "preference" ? `prefers ${v} for running tests over the alternatives` : `uses ${v} for running tests`),
  },
  {
    subject: "ci_system",
    values: ["github actions", "circleci", "gitlab ci", "jenkins"],
    kinds: ["fact"],
    text: (v) => `ci runs on ${v}`,
  },
  {
    subject: "formatter",
    values: ["prettier", "biome", "dprint"],
    kinds: ["fact", "preference"],
    text: (v, k) => (k === "preference" ? `prefers formatting code with ${v}` : `formats code with ${v}`),
  },
  {
    subject: "linter",
    values: ["eslint", "biome", "oxlint"],
    kinds: ["fact"],
    text: (v) => `lints the codebase with ${v}`,
  },
  {
    subject: "architecture",
    values: [
      "hexagonal architecture",
      "event sourcing",
      "a monorepo with workspaces",
      "a single shared database",
      "microservices split by domain boundary",
    ],
    kinds: ["decision"],
    text: (v) => `the architecture decision is to adopt ${v}`,
  },
  {
    subject: "deploy_cadence",
    values: [
      "deploys on tuesdays",
      "deploys continuously on merge to main",
      "deploys weekly on fridays",
      "deploys via canary rollout",
    ],
    kinds: ["decision", "correction"],
    text: (v, k) => (k === "correction" ? `correction: the team actually ${v}, not what was recorded before` : `the team ${v}`),
  },
  {
    subject: "database",
    values: ["postgres", "sqlite", "mysql", "mongodb"],
    kinds: ["fact"],
    text: (v) => `the database is ${v}`,
  },
  {
    subject: "branch_strategy",
    values: ["trunk-based development", "git flow", "github flow"],
    kinds: ["decision"],
    text: (v) => `the branch strategy is ${v}`,
  },
  {
    subject: "commit_convention",
    values: ["conventional commits", "freeform commit messages"],
    kinds: ["decision"],
    text: (v) => `commit messages follow ${v}`,
  },
  {
    subject: "code_review",
    values: [
      "requires two approvals before merging",
      "requires one approval before merging",
      "allows self-merge for small changes",
    ],
    kinds: ["decision"],
    text: (v) => `the review policy ${v}`,
  },
];

const ANCHOR_TEMPLATES = ["file-exists:package.json", "git-tracked:src/index.ts", "glob-exists:*.config.*", "file-exists:.eslintrc"] as const;

export interface EvalFact extends Fact {
  /** Not part of the real `Fact` shape -- eval-only bookkeeping so `queries.ts` can compute a
   * scenario's labelled-relevant set from the same generation pass, instead of hand-picking ids. */
  readonly _template: string;
  readonly _value: string;
  readonly _isDuplicate: boolean;
  readonly _isContradiction: boolean;
}

/** Generates the deterministic fixture corpus. `count` targets roughly this many facts (the exact number varies slightly because duplicate/contradiction pairs are added as pairs). */
export function generateCorpus(seed: number = EVAL_SEED, count = 400): readonly EvalFact[] {
  const rng = mulberry32(seed);
  const facts: EvalFact[] = [];
  let idCounter = 0;
  const nextId = (): string => `f${String(idCounter++).padStart(4, "0")}`;

  const baseDate = Date.UTC(2025, 0, 1);
  const nextCapturedAt = (): string => {
    // Spread capture times over roughly a year, monotonically increasing with generation order so
    // "most recently captured" has a well-defined, reproducible meaning for the recency baseline.
    const dayOffset = facts.length * 7 + Math.floor(rng() * 5);
    return new Date(baseDate + dayOffset * 86_400_000).toISOString();
  };

  function scopeFor(): { scope: FactScope; scopeRoot: string | null } {
    const roll = rng();
    if (roll < 0.35) {
      return { scope: "global", scopeRoot: null };
    }
    const root = pick(rng, PROJECT_ROOTS);
    if (roll < 0.8) {
      return { scope: "project", scopeRoot: root };
    }
    return { scope: "path", scopeRoot: root };
  }

  function makeFact(template: Template, value: string, kind: FactKind, overrides: Partial<EvalFact> = {}): EvalFact {
    const { scope, scopeRoot } = overrides.scope !== undefined ? { scope: overrides.scope, scopeRoot: overrides.scopeRoot ?? null } : scopeFor();
    const anchored = chance(rng, 0.4);
    return {
      id: nextId(),
      text: template.text(value, kind),
      kind,
      subject: template.subject,
      value,
      scope,
      scopeRoot,
      source_type: chance(rng, 0.85) ? "user" : "derived",
      source_ref: null,
      captured_at: nextCapturedAt(),
      anchor: anchored ? pick(rng, ANCHOR_TEMPLATES) : null,
      status: "active",
      confidence: 1,
      embedding: null,
      epoch: facts.length + 1,
      _template: template.subject,
      _value: value,
      _isDuplicate: false,
      _isContradiction: false,
      ...overrides,
    };
  }

  while (facts.length < count) {
    const template = pick(rng, TEMPLATES);
    const kind = pick(rng, template.kinds);
    const value = pick(rng, template.values);
    const fact = makeFact(template, value, kind);
    facts.push(fact);

    // Deliberate exact duplicate: same subject/value/scope/root, different id and capture time --
    // ~12% of generated facts get one.
    if (chance(rng, 0.12)) {
      facts.push({
        ...makeFact(template, value, kind, { scope: fact.scope, scopeRoot: fact.scopeRoot ?? null }),
        _isDuplicate: true,
      });
    }

    // Deliberate contradiction: same subject+scope+root, a *different* value from the same
    // template -- ~10% of generated facts get a rival.
    if (chance(rng, 0.1) && template.values.length > 1) {
      const rivalValues = template.values.filter((v) => v !== value);
      const rivalValue = pick(rng, rivalValues);
      facts.push({
        ...makeFact(template, rivalValue, kind, { scope: fact.scope, scopeRoot: fact.scopeRoot ?? null }),
        _isContradiction: true,
      });
    }
  }

  return facts;
}

export function pickForScenario(rng: () => number, facts: readonly EvalFact[], n: number): EvalFact[] {
  return pickN(rng, facts, n);
}
