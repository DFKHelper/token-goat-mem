/**
 * Library entry point. Re-exports the public surface of every domain module so a consumer can
 * `import { ... } from "token-goat-mem"` instead of reaching into `src/*.js` directly -- e.g. a test,
 * or a future in-process embedding of mem's retrieval pipeline. `src/main.ts` (the CLI executable)
 * does not import this file; it goes straight to `./cli.js`'s `run()`. This module only re-exports --
 * it defines no new behavior of its own.
 */

export type {
  Fact,
  FactFilter,
  FactKind,
  FactScope,
  FactSourceType,
  FactStatus,
  FactUpdate,
  FreshnessVerdict,
  NewFact,
  NewSource,
  Source,
} from "./types.js";

export { insertAuditLog, openDb, resolveDbPath, resolveMemHome, type AuditLogEntry } from "./db.js";

export {
  applyIdempotentAlter,
  countFacts,
  deleteFact,
  deleteSource,
  deleteSourcesForFact,
  deleteSourcesOlderThan,
  ensureStorageSchema,
  getEpoch,
  getFactById,
  insertFact,
  insertSource,
  listFacts,
  listSourcesForFact,
  normalizeSubject,
  openStorage,
  setFactStatus,
  updateFact,
} from "./storage.js";

export { anchorPathWithinRoot, evaluateAnchor, type AnchorVerdict } from "./anchors.js";

export {
  applyContradictionUpdates,
  detectContradictions,
  getGroundTruthFacts,
  resolveContradictions,
  type ContradictionDetectionResult,
  type ContradictionGroup,
  type FactStatusUpdate,
} from "./contradiction.js";

export {
  CaptureValidationError,
  InvalidAnchorError,
  SecretDetectedError,
  captureExplicit,
  captureSuggested,
  loadAllowlist,
  screenForSecrets,
  type CaptureExplicitInput,
  type CaptureResult,
  type CaptureSuggestedInput,
  type SecretMatch,
} from "./capture.js";

export {
  extractMarkdownBullets,
  importFromMarkdown,
  type ImportCandidate,
  type ImportFromMarkdownOptions,
  type ImportOutcome,
  type ImportResult,
  type MarkdownBullet,
} from "./import.js";

export {
  AGGRESSIVE_RECALL_BOOST,
  DEFAULT_ANCHOR_TIME_BUDGET_MS,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  GROUND_TRUTH_CONFIDENCE_FLOOR,
  PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS,
  computeBm25Scores,
  cosineSimilarity,
  reciprocalRankFusion,
  retrieve,
  type ContradictionOutcome,
  type EmbeddingBackend,
  type EmbeddingBackendLoader,
  type RetrievalOptions,
  type RetrievedFact,
  type TrustLevel,
} from "./retrieval.js";

export {
  TGMEM_HEADER,
  TGMEM_PROTOCOL_VERSION,
  buildHintFormat,
  type HintFormatOptions,
  type HintFormatResult,
} from "./integration-seam.js";

export { buildProgram, EXIT_INTERNAL_ERROR, EXIT_SUCCESS, EXIT_USER_ERROR, run, UsageError } from "./cli.js";
