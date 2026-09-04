/**
 * A concrete `EmbeddingBackend` (retrieval.ts) speaking the OpenAI `/v1/embeddings` wire shape,
 * plus the config plumbing that decides whether one exists at all.
 *
 * retrieval.ts deliberately owns no concrete backend: it declares a narrow interface and calls
 * whatever the caller injects, under a hard timeout. This module is the one implementation mem
 * ships, and it is off unless `TOKEN_GOAT_MEM_EMBED_URL` is set -- absent that variable every
 * exported resolver returns `null`, no socket is opened, and ranking is byte-for-byte the BM25-only
 * behaviour that shipped before it existed.
 *
 * The OpenAI shape rather than a bundled local model: it is the one embeddings protocol that
 * OpenAI, Ollama, LM Studio, and LiteLLM all already speak, so a user picks their own endpoint (a
 * localhost one keeps mem's zero-network property intact) instead of mem picking a model, a cache
 * path, and a license for them. It also costs zero dependencies -- global `fetch` and
 * `AbortSignal.timeout` are both present on Node 18, this package's `engines` floor.
 *
 * Everything here treats the endpoint as untrusted input (CLAUDE.md, "Validate at system
 * boundaries"): a non-200, a body that is not the documented shape, a vector of the wrong length,
 * or a stalled connection all surface as a thrown `EmbeddingRequestError`, never as a partially
 * populated result a caller could mistake for a complete one.
 */

import type { EmbeddingBackend } from "./retrieval.js";

/** Environment variable naming the full embeddings endpoint. Its presence is what turns the feature on. */
export const EMBED_URL_ENV = "TOKEN_GOAT_MEM_EMBED_URL";
/** Environment variable naming the embedding model. Required whenever {@link EMBED_URL_ENV} is set. */
export const EMBED_MODEL_ENV = "TOKEN_GOAT_MEM_EMBED_MODEL";
/** Environment variable carrying an optional bearer token. Never logged, echoed, or included in an error. */
export const EMBED_API_KEY_ENV = "TOKEN_GOAT_MEM_EMBED_API_KEY";

/**
 * Default per-request wall clock for a backend created without an explicit budget.
 *
 * Sized for the backfill path (`mem embed`), which is a foreground batch job a user is watching and
 * where a cold local model's first response can take seconds. Every latency-sensitive caller
 * (recall, the token-goat seam, capture) passes its own, much smaller budget instead -- see
 * `EmbeddingBackendOptions.timeoutMs`.
 */
export const DEFAULT_EMBED_REQUEST_TIMEOUT_MS = 10_000;

/** Resolved embeddings configuration. `apiKey` is present only when the user set one. */
export interface EmbeddingConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
}

/** Raised when {@link EMBED_URL_ENV} is set but the rest of the configuration is unusable. */
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

/** Raised when a request to the configured endpoint fails, times out, or answers with something that is not a usable embedding response. */
export class EmbeddingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

export interface EmbeddingBackendOptions {
  /** Per-request wall clock, enforced with `AbortSignal.timeout`. Defaults to {@link DEFAULT_EMBED_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The backend this module builds: an `EmbeddingBackend` that also embeds a whole batch in one request, and reports which model it is configured for. */
export interface HttpEmbeddingBackend extends EmbeddingBackend {
  readonly model: string;
  /** Endpoint host (`host:port`), safe to print. Never the full URL with credentials in it, never the API key. */
  readonly endpointLabel: string;
  embed(text: string): Promise<Float32Array>;
  /** Embeds every text in one request, returning vectors in the same order as `texts`. Rejects with {@link EmbeddingRequestError} rather than returning a short or partly-filled array. */
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Reads the embeddings configuration out of `env`.
 *
 * Returns `null` when the feature is simply off (no {@link EMBED_URL_ENV}), and throws
 * {@link EmbeddingConfigError} when it is on but broken -- a URL with no model, or a URL that is not
 * a URL. The two are different situations and only one of them is a user error worth reporting:
 * `mem embed` and `mem doctor` want the diagnosis, while recall wants to shrug and rank lexically
 * (see {@link resolveConfiguredEmbeddingBackend}, which swallows the throw for exactly that reason).
 */
export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const url = (env[EMBED_URL_ENV] ?? "").trim();
  if (url.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The offending value is echoed because it is an endpoint the user typed, not a credential.
    throw new EmbeddingConfigError(`${EMBED_URL_ENV} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EmbeddingConfigError(`${EMBED_URL_ENV} must be an http(s) URL, got ${parsed.protocol}//`);
  }
  const model = (env[EMBED_MODEL_ENV] ?? "").trim();
  if (model.length === 0) {
    throw new EmbeddingConfigError(`${EMBED_MODEL_ENV} is required when ${EMBED_URL_ENV} is set`);
  }
  const apiKey = (env[EMBED_API_KEY_ENV] ?? "").trim();
  return { url, model, ...(apiKey.length > 0 ? { apiKey } : {}) };
}

/** `host:port` of a configured endpoint, for `mem doctor`. Deliberately drops the path, the query string, and any userinfo, so nothing credential-shaped can reach stdout through this. */
export function endpointLabelFor(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/**
 * One `data` entry of an OpenAI-compatible embeddings response, after shape checking.
 *
 * `index` is required rather than optional. The spec defines it, every endpoint this targets emits
 * it, and it is the only thing that makes a batch response safe: pairing by array position instead
 * would attach every fact a neighbour's vector the first time a server answered out of order, and
 * that failure is silent -- no error, no crash, just permanently wrong similarity for the whole
 * store. Refusing a response that omits it is the cheap half of that trade.
 */
interface EmbeddingResponseItem {
  readonly index: number;
  readonly embedding: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseResponseItem(raw: unknown): EmbeddingResponseItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { index, embedding } = raw;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return null;
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }
  for (const component of embedding) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return null;
    }
  }
  return { index, embedding: embedding as readonly number[] };
}

/**
 * Turns a decoded response body into one vector per requested text, placed by the response's own
 * `index` field.
 *
 * Every rejection here is a case where continuing would produce a plausible-looking but wrong
 * result: a missing slot would silently leave a fact unembedded while the count said otherwise, a
 * duplicate index would overwrite a different fact's vector, and a ragged set of dimensions would
 * later be compared by `cosineSimilarity` over the shorter length and yield a confident number
 * about two incomparable vectors.
 */
function vectorsFromBody(body: unknown, expectedCount: number): Float32Array[] {
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    throw new EmbeddingRequestError("embeddings response has no `data` array");
  }
  const data = body["data"];
  if (data.length !== expectedCount) {
    throw new EmbeddingRequestError(`embeddings response returned ${data.length} vectors for ${expectedCount} inputs`);
  }
  const slots: (Float32Array | undefined)[] = new Array<Float32Array | undefined>(expectedCount).fill(undefined);
  let dimension: number | null = null;
  for (const raw of data) {
    const item = parseResponseItem(raw);
    if (item === null) {
      throw new EmbeddingRequestError("embeddings response contains an entry that is not { index: number, embedding: number[] }");
    }
    if (item.index >= expectedCount) {
      throw new EmbeddingRequestError(`embeddings response used index ${item.index} for a batch of ${expectedCount}`);
    }
    if (slots[item.index] !== undefined) {
      throw new EmbeddingRequestError(`embeddings response repeated index ${item.index}`);
    }
    if (dimension === null) {
      dimension = item.embedding.length;
    } else if (item.embedding.length !== dimension) {
      throw new EmbeddingRequestError(`embeddings response mixed vector dimensions (${dimension} and ${item.embedding.length})`);
    }
    slots[item.index] = Float32Array.from(item.embedding);
  }
  const vectors: Float32Array[] = [];
  for (const slot of slots) {
    if (slot === undefined) {
      throw new EmbeddingRequestError("embeddings response left an input without a vector");
    }
    vectors.push(slot);
  }
  return vectors;
}

/** Builds a backend for an already-resolved config. Exported for tests and for callers that read their config from somewhere other than the environment. */
export function createHttpEmbeddingBackend(config: EmbeddingConfig, options: EmbeddingBackendOptions = {}): HttpEmbeddingBackend {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_REQUEST_TIMEOUT_MS;

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Sent only when the user configured a key: an endpoint that wants no auth (the common
          // localhost case) must not receive a header at all, and there is no placeholder value
          // that would be honest here.
          ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input: [...texts] }),
        // `AbortSignal.timeout` rather than an outer race: a promise the caller stopped waiting on
        // still holds an open socket, and an open socket keeps Node's event loop alive. Without the
        // abort, giving up on a stalled endpoint after 200ms would still leave `mem recall` hanging
        // until the endpoint answered.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The message deliberately names the host, never the URL's userinfo and never the API key.
      const reason = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : "could not be reached";
      throw new EmbeddingRequestError(`embeddings endpoint ${endpointLabelFor(config.url)} ${reason}`);
    }
    if (!response.ok) {
      // Status only. A failing endpoint's body routinely echoes the request headers back, which is
      // the one place an API key would otherwise leak into a user-visible error.
      throw new EmbeddingRequestError(`embeddings endpoint ${endpointLabelFor(config.url)} returned HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmbeddingRequestError(`embeddings endpoint ${endpointLabelFor(config.url)} returned a body that is not JSON`);
    }
    return vectorsFromBody(body, texts.length);
  }

  return {
    model: config.model,
    endpointLabel: endpointLabelFor(config.url),
    embedBatch,
    async embed(text: string): Promise<Float32Array> {
      const [vector] = await embedBatch([text]);
      if (vector === undefined) {
        // Unreachable via `vectorsFromBody`, which never returns a short array; kept so the
        // narrowing is real rather than a non-null assertion that would hide a future regression.
        throw new EmbeddingRequestError("embeddings response returned no vector for a single input");
      }
      return vector;
    },
  };
}

/**
 * The environment-driven entry point: a ready backend, or `null` when embeddings are off.
 *
 * Never throws, for any input. Its callers are the fail-open ones -- recall, the token-goat seam,
 * and the post-capture write -- where the correct response to a broken embeddings setup is to rank
 * lexically and carry on, not to fail a command whose actual job succeeded. Callers that owe the
 * user a diagnosis (`mem embed`, `mem doctor`) call {@link readEmbeddingConfig} directly and handle
 * {@link EmbeddingConfigError} themselves.
 */
export function resolveConfiguredEmbeddingBackend(
  env: NodeJS.ProcessEnv = process.env,
  options: EmbeddingBackendOptions = {}
): HttpEmbeddingBackend | null {
  let config: EmbeddingConfig | null;
  try {
    config = readEmbeddingConfig(env);
  } catch {
    return null;
  }
  return config === null ? null : createHttpEmbeddingBackend(config, options);
}

/** What the store recorded about the vectors currently sitting in `facts.embedding`. */
export interface EmbeddingMeta {
  readonly model: string;
  readonly dimension: number;
}

/** Outcome of asking whether the configured backend may rank against the store's existing vectors. */
export interface EmbeddingRankingPlan {
  /** The backend to hand `retrieve()`, or `null` when embedding search must sit this one out. */
  readonly backend: HttpEmbeddingBackend | null;
  /**
   * Set when a backend is configured but its vectors are not comparable with the stored ones, so
   * `backend` was withheld. A human-readable sentence naming the fix; `null` in every other case,
   * including the ordinary "embeddings are off" one, which is not a problem to report.
   */
  readonly incomparable: string | null;
}

/**
 * Decides whether embedding search may run, given the configured model and the model the stored
 * vectors were produced by.
 *
 * This exists because `cosineSimilarity` cannot detect the mistake it is protecting against: it
 * compares over `Math.min(a.length, b.length)`, so a 768-dimension query vector and a store full of
 * 1536-dimension vectors from a different model produce similarity scores that are numerically fine
 * and semantically meaningless. Nothing errors, nothing logs, and recall quietly starts ranking on
 * noise. Refusing to rank at all is the only honest answer until `mem embed --all` re-embeds the
 * store under the new model.
 */
export function planEmbeddingRanking(
  recorded: EmbeddingMeta | null,
  env: NodeJS.ProcessEnv = process.env,
  options: EmbeddingBackendOptions = {}
): EmbeddingRankingPlan {
  const backend = resolveConfiguredEmbeddingBackend(env, options);
  if (backend === null) {
    return { backend: null, incomparable: null };
  }
  if (recorded !== null && recorded.model !== backend.model) {
    return {
      backend: null,
      incomparable: `stored vectors were produced by ${recorded.model}, not ${backend.model}; run \`mem embed --all\` to re-embed the store`,
    };
  }
  return { backend, incomparable: null };
}
