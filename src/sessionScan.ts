/**
 * Deterministic extraction of durable-preference candidates from a session transcript.
 *
 * The `Stop` hook is the only place mem sees what was actually said: `SessionStart` and
 * `UserPromptSubmit` are recall paths, so until this existed nothing captured unless the agent
 * obeyed the CLAUDE.md instruction block or the user typed `mem remember` themselves. That made
 * capture the weakest link in a tool whose whole job is not forgetting.
 *
 * Two rules constrain everything here, and both are load-bearing rather than stylistic:
 *
 *  1. **No model, no judgement.** Candidates are matched by sentence shape against a fixed trigger
 *     table. The same transcript always yields the same candidates, which is what makes the result
 *     reviewable -- a user resolving a queue needs to know the queue was not invented.
 *  2. **Only the human speaks.** A transcript stores far more than user speech under the user role,
 *     because that is how the protocol carries it: tool results, `<system-reminder>` injections,
 *     slash-command payloads, and compaction summaries of the assistant's own prior output all
 *     arrive as user-role entries, and three of those four are plain `text` blocks rather than
 *     `tool_result` blocks. All of it is untrusted: a file, a web page, an instruction file, or the
 *     assistant's own summarized words containing "always use X" must never become a stored
 *     preference. {@link userTurnText} rejects each of those channels, which together are the
 *     security boundary of this module. Measured against a real 33 MB transcript, dropping only
 *     `tool_result` left 28 candidates of which the large majority came from the other three
 *     channels -- the boundary is not theoretical.
 *
 * Everything captured from here lands `pending` via `captureSuggested` and waits for `mem review`.
 * Nothing in this file can produce an active fact.
 */

import { readFileSync } from "node:fs";

import { normalizeFactText } from "./storage.js";
import type { FactKind } from "./types.js";

/**
 * A sentence shape that marks a durable statement, and the kind it implies.
 *
 * Anchored at the start of a sentence on purpose. "never" mid-sentence is usually narration ("it
 * should never have shipped"); "Never commit secrets" as an opener is an instruction. Anchoring
 * trades recall for precision, which is the right trade when every hit costs a human a review
 * decision and the cost of a miss is that the user types `mem remember` as they always have.
 */
interface Trigger {
  readonly pattern: RegExp;
  readonly kind: FactKind;
}

const TRIGGERS: readonly Trigger[] = [
  // The kinds mirror CLAUDE.md's own guidance for what these phrasings mean.
  { pattern: /^remember that\b/i, kind: "fact" },
  { pattern: /^(?:from now on|going forward)\b/i, kind: "preference" },
  { pattern: /^(?:always|never)\b/i, kind: "preference" },
  { pattern: /^(?:don't|do not|dont)\b/i, kind: "preference" },
  { pattern: /^we(?:'ve| have)? decided\b/i, kind: "decision" },
  { pattern: /^(?:we should|let's|lets) (?:always|never)\b/i, kind: "preference" },
  { pattern: /^decision:\s*/i, kind: "decision" },
  { pattern: /^rule:\s*/i, kind: "decision" },
];

/**
 * Discourse openers skipped when looking for a trigger, so the anchors stay anchored.
 *
 * Measured against seven ordinary phrasings of a durable preference, the `^` anchors matched one.
 * Every miss was a sentence that opens with a filler word and then says exactly what the anchored
 * form says ("Please always run the linter"). Relaxing the anchor to a substring search would fix
 * those and reintroduce the false positives the anchor exists to stop ("I never got that to work"),
 * so this is a closed list instead: the trigger still has to be the very next thing said, and only
 * these specific words may precede it. Skipping is for *matching* only -- the stored text is the
 * whole sentence, because a fact whose text was quietly edited is a fact the user never said.
 */
const DISCOURSE_PREFIX = /^(?:(?:please|also|so|ok|okay|note(?: that)?)[,:]?\s+)+/iu;

/**
 * Upper bound on user turns examined, counted from the end of the transcript.
 *
 * The Stop hook fires at the end of every assistant turn, so a long session re-scans the same
 * history repeatedly. Duplicate candidates are already discarded by the caller, so this bound
 * caps how many turns are extracted and screened, not how much is read -- the whole file is
 * read and parsed before the window is sliced.
 */
export const MAX_SCANNED_TURNS = 200;

/** Longest candidate kept. A fact that does not fit here is prose, not a durable statement. */
export const MAX_CANDIDATE_LENGTH = 300;

/** Shortest candidate kept, past the trigger word -- guards against a bare "never." as a candidate. */
const MIN_CANDIDATE_LENGTH = 12;

export interface Candidate {
  /** The matched sentence, whitespace-collapsed and trimmed. */
  readonly text: string;
  /** The kind implied by the trigger that matched. */
  readonly kind: FactKind;
  /** Zero-based index of the user turn it came from, for `source_ref`. */
  readonly turnIndex: number;
}

/**
 * Entry flags that mark a user-role entry as something other than the user talking.
 *
 * `isCompactSummary` is the costly one: a compaction summary is the *assistant's* account of the
 * conversation, stored as a user-role text block. Scanning one turns every rule the assistant
 * restated ("Never spawn more than one agent") into a candidate the user never typed.
 */
const REJECTED_ENTRY_FLAGS: readonly string[] = ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly"];

/**
 * Text wrappers whose presence means the block is machinery rather than speech: a slash command's
 * expansion and its stdout. The whole block is dropped -- these carry no user prose worth keeping,
 * and their payload is exactly the untrusted content this module exists to exclude.
 */
const WRAPPER_MARKERS: readonly string[] = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  // A subagent's report, relayed to the session under the user role. The sharpest case of all:
  // without this, anything a spawned agent writes is indistinguishable from something the user said.
  "<task-notification>",
];

/**
 * A `<system-reminder>` span, stripped rather than dropping the whole block: the host appends these
 * to real user turns, so the turn around one is genuine speech. Their content is injected
 * instruction text (often a verbatim CLAUDE.md), which is precisely what must not become a fact.
 */
const SYSTEM_REMINDER_SPAN = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;

/**
 * The speech left in one piece of user-role text, or `undefined` when none of it is speech.
 *
 * Both content shapes go through here. `content` is sometimes a bare string instead of an array of
 * blocks, and routing the string shape straight out -- as an earlier version of this did -- silently
 * exempted it from every filter below, which is how a `<local-command-stdout>` dump was still
 * producing candidates after the block path had been hardened.
 */
function humanText(text: unknown): string | undefined {
  if (typeof text !== "string" || WRAPPER_MARKERS.some((marker) => text.includes(marker))) {
    return undefined;
  }
  const stripped = text.replace(SYSTEM_REMINDER_SPAN, " ").trim();
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * The human-authored text of one transcript entry, or `undefined` when the entry is not a user turn.
 *
 * `content` is either a bare string or an array of typed blocks. Only `text` blocks count: a
 * `tool_result` block is stored under the user role but was written by a tool, and treating it as
 * user speech would let any file mem reads dictate what mem remembers. See the module doc.
 */
export function userTurnText(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (record["type"] !== "user") {
    return undefined;
  }
  if (REJECTED_ENTRY_FLAGS.some((flag) => record[flag] === true)) {
    return undefined;
  }
  // A tool-result envelope, identified by the entry key rather than by its block type. Belt and
  // braces with the block-level check below, since the two are set independently.
  if (record["toolUseResult"] !== undefined) {
    return undefined;
  }
  // When the host says where an entry came from, believe it -- but only in the rejecting direction.
  // Claude Code tags a typed prompt `{kind: "human"}` and a relayed subagent report
  // `{kind: "task-notification"}`. Requiring the field would make every host that omits it scan
  // nothing; rejecting on a non-human value costs nothing and is exact where it is present.
  const origin = record["origin"];
  if (typeof origin === "object" && origin !== null) {
    const kind = (origin as Record<string, unknown>)["kind"];
    if (typeof kind === "string" && kind !== "human") {
      return undefined;
    }
  }
  const message = record["message"];
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") {
    return humanText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const typed = block as Record<string, unknown>;
    if (typed["type"] !== "text") {
      continue;
    }
    const human = humanText(typed["text"]);
    if (human !== undefined) {
      parts.push(human);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Splits a turn into candidate sentences.
 *
 * Newlines split as hard as sentence enders because instructions arrive as bullet lists at least as
 * often as prose, and a bullet is a sentence whether or not it was punctuated. Leading list markers
 * are stripped so `- never commit secrets` matches the same trigger as `Never commit secrets`.
 */
function sentences(turn: string): string[] {
  return turn
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** Whether the turn is a slash command invocation rather than something the user said in prose. */
function isSlashCommand(turn: string): boolean {
  return /^\s*\//.test(turn);
}

/**
 * Extracts candidates from already-isolated user turns, newest-last.
 *
 * Exported separately from {@link scanTranscript} so the matching rules can be tested without a
 * transcript file, which is where the interesting cases live.
 */
export function extractCandidates(turns: readonly string[]): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  turns.forEach((turn, turnIndex) => {
    if (isSlashCommand(turn)) {
      return;
    }
    for (const sentence of sentences(turn)) {
      const claim = sentence.replace(DISCOURSE_PREFIX, "");
      let trigger: Trigger | undefined;
      let triggerMatch: RegExpExecArray | null = null;
      for (const candidate of TRIGGERS) {
        const match = candidate.pattern.exec(claim);
        if (match !== null) {
          trigger = candidate;
          triggerMatch = match;
          break;
        }
      }
      if (trigger === undefined || triggerMatch === null) {
        continue;
      }
      // Measured past the matched trigger, not the raw sentence -- "Remember that." and "We have
      // decided." both clear a floor measured against the whole sentence while carrying zero claim
      // content past the trigger word, which is exactly what this floor exists to reject.
      const residualLength = claim.length - triggerMatch[0].length;
      if (residualLength < MIN_CANDIDATE_LENGTH || sentence.length > MAX_CANDIDATE_LENGTH) {
        continue;
      }
      // Within one scan the same sentence repeated across turns is one candidate. Cross-scan
      // duplicates are the caller's problem, since only the caller can see the store. Normalized
      // via the same function `storage.ts`'s cross-scan check now uses -- they used to be two
      // hand-maintained rules (this one Unicode-aware, the store's SQL-`LOWER()`-based) that
      // silently disagreed on any sentence containing an uppercase non-ASCII letter.
      const key = normalizeFactText(sentence);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push({ text: sentence, kind: trigger.kind, turnIndex });
    }
  });
  return found;
}

/**
 * Reads a JSONL transcript and returns its candidates.
 *
 * Never throws: an unreadable, missing, or malformed transcript yields no candidates. A Stop hook
 * that fails is a hook that interrupts the user's session for a background convenience, which is
 * the opposite of the fail-open contract the rest of the seam keeps. Malformed *lines* are skipped
 * individually rather than abandoning the file, because a transcript being appended to as we read
 * can legitimately end mid-line.
 */
export function scanTranscript(transcriptPath: string): Candidate[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const turns: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userTurnText(parsed);
    if (text !== undefined && text.trim().length > 0) {
      turns.push(text);
    }
  }
  // `turnIndex` leaves this module as `<transcript>#turn<n>` in a suggestion's `source_ref`, so it
  // has to mean a position in the transcript rather than in the window. Numbering from the slice
  // made the pointer slide: the same sentence reported a different turn on every scan as the
  // transcript grew past the cap, so provenance neither located the sentence nor stayed put.
  const window = turns.slice(-MAX_SCANNED_TURNS);
  const offset = turns.length - window.length;
  return extractCandidates(window).map((candidate) => ({ ...candidate, turnIndex: offset + candidate.turnIndex }));
}
