/**
 * Cross-fact inference ("dreaming"): propose facts that follow from several stored facts but that
 * nobody stated outright.
 *
 * Everything else in this codebase is deterministic. This is not, and that is the point: merging
 * near-duplicates, resolving contradictions, and decaying old preferences are all mechanical, and
 * none of them can notice that three separate facts about deploy steps add up to "deploys are
 * manual". That inference is the one capability a rule cannot reach.
 *
 * **This module writes nothing.** It is an evaluation surface, deliberately: the open question is
 * whether a model's inferences over a real store are good enough to be worth a review queue, and
 * that is answerable by reading them. Building the storage, review, and hook machinery first would
 * be building the expensive half against an assumption. If the output proves worth keeping, the
 * shape it must take is already fixed by the rest of the system -- `captureSuggested`, so every
 * candidate lands `pending` with `source_type: "derived"` and reaches recall only through an
 * explicit `mem review --promote`. A fact nobody said must never be surfaced as if somebody had.
 *
 * **It is off unless configured, and once configured it sends stored fact text off the machine.**
 * `TOKEN_GOAT_MEM_DREAM_URL` + `TOKEN_GOAT_MEM_DREAM_MODEL` name an OpenAI-compatible chat-completions
 * endpoint, matching the opt-in shape src/embeddings.ts already established -- that other opt-in path
 * sends fact/query text of its own, to a separate endpoint, when configured. Unset, `mem dream` says
 * so and does nothing. Point it at a local endpoint if the store holds anything you would not paste
 * into a hosted API.
 *
 * **Store content is data, not instruction.** Facts reach the store from files and transcripts via
 * `mem import`/`mem scan-session`, so a fact's text can contain anything -- including text aimed at
 * whatever model reads it next. Two things bound that: the response is accepted only as a strict
 * JSON array whose every element is shape-checked and range-checked here, so the model cannot make
 * this module do anything other than emit candidates; and no candidate is written anywhere, so the
 * worst a hostile fact achieves is a bad suggestion in a list a human is already reading critically.
 */

import type { Fact } from "./types.js";
import { normalizeFactText } from "./storage.js";

/** Environment variable naming the full chat-completions endpoint (e.g. `https://api.example.com/v1/chat/completions`). Unset disables `mem dream` entirely. */
export const DREAM_URL_ENV = "TOKEN_GOAT_MEM_DREAM_URL";

/** Environment variable naming the model to ask. Required whenever {@link DREAM_URL_ENV} is set. */
export const DREAM_MODEL_ENV = "TOKEN_GOAT_MEM_DREAM_MODEL";

/** Environment variable carrying an optional bearer token. Omitted entirely when unset, since a local endpoint that wants no auth must not receive the header. */
export const DREAM_API_KEY_ENV = "TOKEN_GOAT_MEM_DREAM_API_KEY";

/** Default wall clock for the request. Generous next to embeddings' budget: this is one interactive command, not a call on the recall path. */
const DEFAULT_DREAM_TIMEOUT_MS = 60_000;

/**
 * Cap on facts sent in one request. A store larger than this is truncated to its most recent facts
 * and the caller is told, rather than silently reasoning over part of the store or blowing a context
 * window the endpoint never advertised.
 */
export const MAX_DREAM_FACTS = 200;

/** Cap on a candidate's text, matching the capture path's own limit so nothing is proposed that could not be stored. */
const MAX_CANDIDATE_TEXT = 500;

/** Fewest stored facts a candidate must cite. One is a restatement, not an inference — the whole value here is the *cross*-fact step. */
const MIN_SUPPORTING_FACTS = 2;

/** Kinds a candidate may claim, mirroring `FACT_KINDS` minus `correction`: a correction is something a user does to a fact, not something inferred about a codebase. */
const CANDIDATE_KINDS: readonly string[] = ["preference", "decision", "fact"];

export interface DreamConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
}

/** Raised when {@link DREAM_URL_ENV} is set but the rest of the configuration is unusable. */
export class DreamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamConfigError";
  }
}

/** Raised when the endpoint fails, times out, or answers with something that is not a usable set of candidates. */
export class DreamRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamRequestError";
  }
}

/** One proposed inference, with the stored facts it claims to follow from. */
export interface DreamCandidate {
  readonly text: string;
  readonly kind: string;
  /** Ids of the stored facts the model cited. Always at least {@link MIN_SUPPORTING_FACTS}, always facts that were actually sent. */
  readonly supports: readonly string[];
}

/** Reads the dreaming configuration out of `env`. `null` means "not configured", which is the normal state and never an error. */
export function readDreamConfig(env: NodeJS.ProcessEnv = process.env): DreamConfig | null {
  const url = (env[DREAM_URL_ENV] ?? "").trim();
  if (url.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Echoed because it is an endpoint the user typed, not a credential.
    throw new DreamConfigError(`${DREAM_URL_ENV} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DreamConfigError(`${DREAM_URL_ENV} must be an http(s) URL, got ${parsed.protocol}//`);
  }
  const model = (env[DREAM_MODEL_ENV] ?? "").trim();
  if (model.length === 0) {
    throw new DreamConfigError(`${DREAM_MODEL_ENV} is required when ${DREAM_URL_ENV} is set`);
  }
  const apiKey = (env[DREAM_API_KEY_ENV] ?? "").trim();
  return { url, model, ...(apiKey.length > 0 ? { apiKey } : {}) };
}

/** `host:port` of a configured endpoint, safe to print: never the path, never userinfo, never the key. */
export function dreamEndpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable endpoint)";
  }
}

/**
 * The instruction sent with every request.
 *
 * Written to make the model's job narrow and its output checkable rather than to make it clever: an
 * inference must cite the facts it came from, so a reader can judge the step instead of the claim.
 * The refusal clause matters more than the rest -- a model asked for insights will always produce
 * some, and a store with nothing to infer must be allowed to return an empty list.
 */
const SYSTEM_PROMPT = [
  "You infer facts about a software project from facts already recorded about it.",
  "You are given numbered facts. Propose only statements that follow from TWO OR MORE of them together and that none of them states on its own.",
  "Do not restate, merge, summarize, or reword a single fact. Do not propose anything you cannot ground in the numbered facts.",
  "If nothing worthwhile follows from the facts given, return an empty array. An empty array is a correct and expected answer.",
  'Reply with JSON only, no prose and no code fence: {"candidates":[{"text":"...","kind":"preference|decision|fact","supports":[1,4]}]}',
  '"supports" lists the numbers of the facts the statement follows from. "text" is one short sentence.',
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pulls the assistant's message text out of an OpenAI-compatible chat-completions body.
 *
 * Shape-checked at every level rather than indexed through: a body that is not this shape is an
 * endpoint problem to report, and reading `undefined` off it would surface much later as an
 * unexplained empty result.
 */
function messageContentFrom(body: unknown, label: string): string {
  if (!isRecord(body) || !Array.isArray(body["choices"])) {
    throw new DreamRequestError(`dream endpoint ${label} returned a body with no choices array`);
  }
  const first: unknown = body["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) {
    throw new DreamRequestError(`dream endpoint ${label} returned a choice with no message`);
  }
  const content = first["message"]["content"];
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new DreamRequestError(`dream endpoint ${label} returned an empty message`);
  }
  return content;
}

/**
 * Finds the JSON object in a reply that may be wrapped in a code fence or prose.
 *
 * The prompt asks for bare JSON and most models comply, but a stray fence is the single most common
 * deviation and failing the whole run over it would be brittle for no gain. Nothing beyond locating
 * the outermost braces is forgiven: the content between them still has to parse.
 */
function parseJsonReply(content: string, label: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new DreamRequestError(`dream endpoint ${label} returned a reply containing no JSON object`);
  }
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new DreamRequestError(`dream endpoint ${label} returned a reply whose JSON did not parse`);
  }
}

/**
 * Turns one raw candidate into a checked one, or `null` to drop it.
 *
 * Dropping rather than throwing on a bad element: one malformed candidate in ten is a model being
 * imprecise, not an endpoint being broken, and discarding the run's other nine would make the
 * command's usefulness depend on the model's worst output rather than its best.
 */
function checkCandidate(raw: unknown, sent: readonly Fact[], existing: ReadonlySet<string>): DreamCandidate | null {
  if (!isRecord(raw)) {
    return null;
  }
  const text = typeof raw["text"] === "string" ? raw["text"].trim() : "";
  if (text.length === 0 || text.length > MAX_CANDIDATE_TEXT) {
    return null;
  }
  // A "new" fact that repeats one already in the store is the failure mode the prompt warns against
  // twice; catching it here means the guarantee does not depend on the model having listened.
  if (existing.has(normalizeFactText(text))) {
    return null;
  }
  const kind = typeof raw["kind"] === "string" ? raw["kind"].trim().toLowerCase() : "";
  if (!CANDIDATE_KINDS.includes(kind)) {
    return null;
  }
  const rawSupports = raw["supports"];
  if (!Array.isArray(rawSupports)) {
    return null;
  }
  const supports: string[] = [];
  for (const entry of rawSupports) {
    // 1-based in the prompt, so a model that echoes the numbers it was shown lines up here.
    const index = typeof entry === "number" ? entry - 1 : Number.NaN;
    const fact = Number.isInteger(index) ? sent[index] : undefined;
    if (fact !== undefined && !supports.includes(fact.id)) {
      supports.push(fact.id);
    }
  }
  // A citation the caller cannot follow is worse than no citation: it looks like grounding and is
  // not. Both the count floor and the range check exist so every id printed is one `mem show` finds.
  return supports.length >= MIN_SUPPORTING_FACTS ? { text, kind, supports } : null;
}

export interface DreamResult {
  readonly candidates: readonly DreamCandidate[];
  /** Facts actually sent, after the {@link MAX_DREAM_FACTS} cap. */
  readonly sent: readonly Fact[];
  /** How many live facts existed, so a truncated run can say so. */
  readonly available: number;
  readonly endpointLabel: string;
  readonly model: string;
}

export interface DreamOptions {
  readonly timeoutMs?: number;
  /** Injected in tests so the module's own request shaping and response checking are exercised without a live endpoint. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Asks the configured model what follows from `facts`, and returns the checked candidates.
 *
 * Sends the most recent {@link MAX_DREAM_FACTS} facts, newest first, so a truncated run keeps the
 * part of the store most likely to still be true.
 */
export async function dream(
  facts: readonly Fact[],
  config: DreamConfig,
  options: DreamOptions = {}
): Promise<DreamResult> {
  const label = dreamEndpointLabel(config.url);
  const ordered = [...facts].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const sent = ordered.slice(0, MAX_DREAM_FACTS);
  if (sent.length < MIN_SUPPORTING_FACTS) {
    // Nothing to cross-reference. Reported as an empty result rather than a request the endpoint
    // would be paid for and could only answer with an empty list.
    return { candidates: [], sent, available: facts.length, endpointLabel: label, model: config.model };
  }

  const numbered = sent.map((fact, index) => `${index + 1}. [${fact.kind}] ${fact.text}`).join("\n");
  const timeoutMs = options.timeoutMs ?? DEFAULT_DREAM_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        // Zero temperature will not make this deterministic -- no sampling setting does across
        // providers -- but it removes the one source of variation under our control, so two runs
        // over an unchanged store differ because the model does, not because we asked it to.
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Facts:\n${numbered}` },
        ],
      }),
      // Same reasoning as embeddings.ts: a promise the caller stopped awaiting still holds a socket
      // open, and an open socket keeps Node alive past the point the command should have exited.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : "could not be reached";
    throw new DreamRequestError(`dream endpoint ${label} ${reason}`);
  }
  if (!response.ok) {
    // Status only: a failing endpoint's body routinely echoes request headers, which is the one
    // place an API key would leak into a user-visible error.
    throw new DreamRequestError(`dream endpoint ${label} returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DreamRequestError(`dream endpoint ${label} returned a body that is not JSON`);
  }

  const parsed = parseJsonReply(messageContentFrom(body, label), label);
  const rawCandidates = isRecord(parsed) ? parsed["candidates"] : undefined;
  if (!Array.isArray(rawCandidates)) {
    throw new DreamRequestError(`dream endpoint ${label} returned JSON with no candidates array`);
  }
  const existing = new Set(facts.map((fact) => normalizeFactText(fact.text)));
  const candidates = rawCandidates
    .map((raw) => checkCandidate(raw, sent, existing))
    .filter((candidate): candidate is DreamCandidate => candidate !== null);

  return { candidates, sent, available: facts.length, endpointLabel: label, model: config.model };
}
