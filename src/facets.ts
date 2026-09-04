/**
 * Structured facet extraction: the tokens BM25's tokenizer destroys, preserved verbatim.
 *
 * `retrieval.ts`'s `tokenize` lowercases, splits on `[^a-z0-9]+`, drops stopwords, and Porter-stems
 * whatever survives. That is the right shape for prose and the wrong shape for identifiers:
 * `src/retrieval.ts` reaches the index as the three unrelated terms `src`/`retriev`/`ts`,
 * `PostgreSQL` and `postgres` collapse onto one stem, `v2.1.0` becomes `v2`/`1`/`0`, and
 * `AGGRESSIVE_RECALL_BOOST` becomes `aggress`/`recall`/`boost`. So the one query a user is most
 * certain about -- naming a file, a flag, a constant, or a version exactly -- is precisely the
 * query the lexical index cannot answer. This module extracts those tokens as a second, structured
 * facet stored beside the fact (`fact_terms` in storage.ts) and read back by `mem recall --entity`.
 *
 * Two rules hold the layer together:
 *
 *   - **Entities are verbatim.** Original case, original punctuation, no stemming. Anything this
 *     module normalizes is something BM25 already normalizes better, and a facet that agrees with
 *     the index is a noisier copy of it rather than a second signal.
 *   - **Topics are `tokenize`'s output, imported rather than reimplemented.** Two tokenizers that
 *     must agree is a defect waiting for the first divergence, and the consumer of `topic` rows is
 *     expected to mean exactly BM25's notion of a term.
 *
 * Extraction is deterministic and purely local: the same text always yields the same lists in the
 * same order, with no LLM, no network, and no failure mode. That is what lets the write path run it
 * inside the same transaction as the fact insert (see storage.ts's `insertFact`).
 */

import { tokenize } from "./retrieval.js";

/** The two facet lists extracted from one fact's text. Both are de-duplicated and in first-occurrence order. */
export interface FactFacets {
  /** Identifier-shaped tokens preserved exactly as written (case and punctuation intact). */
  readonly entities: readonly string[];
  /** Stemmed, stopword-filtered content terms -- BM25's own terms, via `tokenize`. */
  readonly topics: readonly string[];
}

/**
 * Per-fact caps on how many rows one extraction may write.
 *
 * A fact's text is user-supplied and bounded only by capture.ts's length guard, so a single
 * pathological capture -- a pasted lockfile, a stack trace, a base64 blob -- could otherwise write
 * thousands of `fact_terms` rows and make every later term statistic a report about that one fact.
 * Truncation happens after de-duplication and keeps the earliest occurrences, so the terms that
 * survive are the ones the text leads with.
 */
export const MAX_ENTITIES_PER_FACT = 32;
export const MAX_TOPICS_PER_FACT = 64;

/**
 * Longest chunk still considered as an entity candidate. Nothing a human types as a path, flag, or
 * identifier is longer; anything that is, is a blob that would be stored verbatim and matched by
 * nobody.
 */
const MAX_ENTITY_LENGTH = 128;

/**
 * The lookup form of a term: trimmed and lowercased.
 *
 * Entity matching is case-insensitive on lookup but case-preserving in storage, so a user who types
 * `postgresql` finds a fact that says `PostgreSQL` and still sees it spelled the way it was
 * written. The key is stored as its own column rather than computed with SQL `LOWER()` at query
 * time because the same comparison also has to happen *in memory*: `retrieval.ts` filters on
 * entities inside `retrieve()` (see `RetrievalOptions.entities`) and never touches a database, so
 * the normalization rule has to exist in TypeScript regardless. Persisting its output keeps the SQL
 * lookups (`listFactIdsForTerm`, `listEntityCounts`) and the in-memory filter provably agreeing on
 * one rule instead of two implementations that merely look alike.
 */
export function normalizeTermKey(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Characters that can never appear *inside* an identifier and so delimit entity candidates:
 * whitespace, quotes, brackets, and the list punctuation prose uses to separate them. Deliberately
 * excludes `.`, `/`, `\`, `-`, `_`, `:`, `@`, `^`, `~`, `+`, all of which are load-bearing inside
 * the shapes below.
 */
const CHUNK_SEPARATORS = /[\s"'`(){}[\],;<>|]+/u;

/** Sentence punctuation trailing a chunk, so `use src/retrieval.ts.` yields `src/retrieval.ts`. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

const PATH_LIKE = /^[A-Za-z0-9_.@~:+-]+(?:[/\\][A-Za-z0-9_.@~:+-]+)+$/u;
const DOTTED = /^[A-Za-z0-9_@~+-]+(?:\.[A-Za-z0-9_@~+-]+)+$/u;
const SNAKE_CASE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/u;
const BARE_WORD = /^[A-Za-z][A-Za-z0-9]*$/u;
const INTERNAL_CASE_CHANGE = /[a-z][A-Z]/u;
const CLI_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/u;
const VERSION = /^[v^~]?[<>=]*\d+\.\d+(?:\.[A-Za-z0-9.+-]+)?$/u;

/**
 * Two or more segments joined by `/` or `\` -- `src/retrieval.ts`, `.github/workflows/ci.yml`,
 * `@scope/package`.
 *
 * The extra condition on the two-segment case is what keeps prose out. `and/or`, `read/write`, and
 * `he/she` are the same shape as a two-segment path and appear in ordinary English; a real path
 * almost always carries an extension, a dot, a digit, a scope marker, or a capital somewhere. Three
 * or more segments is on its own strong enough evidence -- prose does not stack slashes.
 */
function isPathLike(chunk: string): boolean {
  if (!PATH_LIKE.test(chunk)) {
    return false;
  }
  const segments = chunk.split(/[/\\]/u);
  return segments.length > 2 || segments.some((segment) => /[^a-z]/u.test(segment));
}

/**
 * A dotted identifier or filename: `package.json`, `retrieval.ts`, `foo.bar.baz`, `1.2`.
 *
 * The segment-length condition rejects `e.g` and `i.e` (and `a.k.a`), which survive the chunk
 * splitter looking exactly like dotted identifiers and are prose. Requiring one segment to be
 * longer than a single character -- or to contain a digit, which is what keeps the numeric `1.2`
 * in -- separates them without a hand-maintained list of abbreviations that would be wrong in the
 * next language mem sees.
 */
function isDottedIdentifier(chunk: string): boolean {
  if (!DOTTED.test(chunk)) {
    return false;
  }
  return chunk.split(".").some((segment) => segment.length > 1 || /\d/u.test(segment));
}

/**
 * `camelCase`/`PascalCase` -- but only with an *internal* case change (`packEmbedding`,
 * `PostgreSQL`).
 *
 * A capitalized word at the start of a sentence and an all-caps acronym in prose (`HTTP`, `NASA`)
 * both lack one, which is exactly why the test is a lower-to-upper transition rather than "contains
 * a capital": without it every sentence's first word would become an entity and the facet layer
 * would be a second copy of the BM25 index with worse recall.
 */
function isMixedCaseIdentifier(chunk: string): boolean {
  return BARE_WORD.test(chunk) && INTERNAL_CASE_CHANGE.test(chunk);
}

function isEntityCandidate(chunk: string): boolean {
  return (
    isPathLike(chunk) ||
    isDottedIdentifier(chunk) ||
    SNAKE_CASE.test(chunk) ||
    isMixedCaseIdentifier(chunk) ||
    CLI_FLAG.test(chunk) ||
    VERSION.test(chunk)
  );
}

/** Splits `text` into entity candidates: separator-delimited chunks with sentence punctuation trimmed off the end. */
function candidateChunks(text: string): string[] {
  return text
    .split(CHUNK_SEPARATORS)
    .map((chunk) => chunk.replace(TRAILING_PUNCTUATION, ""))
    .filter((chunk) => chunk.length > 0 && chunk.length <= MAX_ENTITY_LENGTH);
}

/**
 * Extracts the entity and topic facets of one fact's text.
 *
 * Deterministic in both content and order: entities appear in first-occurrence order with the
 * spelling the text used, de-duplicated on their normalized key (so a text saying both `PostgreSQL`
 * and `postgresql` stores the first one once, not two rows that mean the same thing).
 */
export function extractFacets(text: string): FactFacets {
  const entities: string[] = [];
  const seenEntities = new Set<string>();
  for (const chunk of candidateChunks(text)) {
    if (entities.length >= MAX_ENTITIES_PER_FACT) {
      break;
    }
    if (!isEntityCandidate(chunk)) {
      continue;
    }
    const key = normalizeTermKey(chunk);
    if (key.length === 0 || seenEntities.has(key)) {
      continue;
    }
    seenEntities.add(key);
    entities.push(chunk);
  }

  const topics: string[] = [];
  const seenTopics = new Set<string>();
  for (const token of tokenize(text)) {
    if (topics.length >= MAX_TOPICS_PER_FACT) {
      break;
    }
    if (seenTopics.has(token)) {
      continue;
    }
    seenTopics.add(token);
    topics.push(token);
  }

  return { entities, topics };
}
