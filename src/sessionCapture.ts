/** Files a session transcript's durable-statement candidates as pending suggestions -- the store side of `mem scan-session`, shared with `mem reflect`'s Stop hook so both file a transcript by exactly the same rules. {@link scanTranscript} decides what counts as a candidate (sessionScan.ts); this module decides what a candidate does to the store. */

import type Database from "better-sqlite3";
import { resolve } from "node:path";

import { buildScreenedExcerpt, captureSuggested, CaptureValidationError, recordSighting, SecretDetectedError } from "./capture.js";
import { isBoundToRoot } from "./projectIdentity.js";
import { scanTranscript } from "./sessionScan.js";
import { factsByTextHash } from "./storage.js";
import type { FactScope } from "./types.js";

/** The `source_ref` prefix every suggestion filed from `transcriptPath` carries (`<path>#turn<n>`), so "which pending facts came from this transcript" is a prefix test against the same string the filer wrote rather than a second copy of its format. Resolved to an absolute path first: the Stop hook files under the absolute path, so a caller that names the same transcript relatively must still match what was stored. */
export function transcriptSourceRefPrefix(transcriptPath: string): string {
  return `${resolve(transcriptPath)}#turn`;
}

export interface FileTranscriptOptions {
  readonly transcriptPath: string;
  /** Project root the captured facts bind to. */
  readonly root: string;
  /** `path` is refused by the callers: a transcript sentence names no single file to bind to. */
  readonly scope: Exclude<FactScope, "path">;
}

/** Scans `transcriptPath` and files every candidate not already in the store as a `pending` suggestion, returning the ids of the facts it created (restatements create none). An unreadable transcript yields no candidates rather than an error -- the hook path must fail open; a caller that named the file explicitly checks readability itself first. */
export function fileTranscriptSuggestions(db: Database.Database, options: FileTranscriptOptions): string[] {
  const { transcriptPath, root, scope } = options;
  const kept: string[] = [];
  for (const candidate of scanTranscript(transcriptPath)) {
    // One indexed lookup per candidate (`idx_facts_text_hash`) rather than a whole-table scan built once up front: a session's candidate count is typically far smaller than the store's total fact count, so this reads only the rows that could possibly match instead of the whole facts table (embedding blobs included) on every hook run. Scoped to this project (or globally, for a global-scope match) via `isBoundToRoot` -- the same rule `retrieval.ts` uses to decide what recall may surface -- rather than a second copy of "does this apply here" re-implemented against `scope_root` directly. A text match with an unrelated project's `scope_root` does not count: that project's suggestion (or rejection) must not suppress this one's.
    const boundMatches = factsByTextHash(db, candidate.text).filter((fact) => isBoundToRoot(fact, root));
    if (boundMatches.length > 0) {
      // A restatement of a `pending` suggestion is evidence for `mem review`'s human reader (`recordSighting`'s own doc comment covers the screening/dedup/no-promotion contract) -- a match against anything else (active, superseded, ...) has no pending row to record a sighting against, and this candidate is simply already known, exactly as before.
      for (const fact of boundMatches) {
        if (fact.status === "pending") {
          recordSighting(db, fact.id, candidate.context, root, candidate.text);
        }
      }
      continue;
    }
    // The whole turn is genuinely larger than the sentence captured as the fact, which is exactly the provenance gap `sources` exists to close -- screened separately because a turn can carry a secret the extracted sentence did not (see buildScreenedExcerpt doc). `null` (screened positive) means no source row, never a blocked capture.
    const sourceExcerpt = buildScreenedExcerpt(candidate.context, root, candidate.text);
    try {
      const { fact } = captureSuggested(db, {
        text: candidate.text,
        kind: candidate.kind,
        scope,
        root,
        sourceRef: `${transcriptSourceRefPrefix(transcriptPath)}${candidate.turnIndex}`,
        ...(sourceExcerpt !== null ? { sourceExcerpt } : {}),
        ...(candidate.capturedAt !== undefined ? { capturedAt: candidate.capturedAt } : {}),
      });
      kept.push(fact.id);
    } catch (error) {
      // One rejected candidate must not abandon the rest. `captureSuggested` throws for secret screening and for validation, and a transcript is exactly where a pasted credential shows up -- that rejection is the screening working, not a scan failure. Any other error (SqliteError, disk full, readonly store) is a real failure and must not be silently swallowed.
      if (error instanceof CaptureValidationError || error instanceof SecretDetectedError) {
        continue;
      }
      throw error;
    }
  }
  return kept;
}
