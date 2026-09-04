/**
 * Unit tests for the OpenAI-compatible embedding backend (src/embeddings.ts).
 *
 * The HTTP half runs against tests/support/embedding-server.ts -- a `node:http` server started
 * inside the test process on an ephemeral loopback port. No new dependency, and no outbound request
 * ever leaves the machine.
 */
import { describe, it, expect, afterEach } from "vitest";

import { defaultVector, startStubEmbeddingServer, type StubEmbeddingServer, type StubEmbeddingServerOptions } from "../support/embedding-server.js";

import {
  EMBED_API_KEY_ENV,
  EMBED_MODEL_ENV,
  EMBED_URL_ENV,
  EmbeddingConfigError,
  EmbeddingRequestError,
  createHttpEmbeddingBackend,
  endpointLabelFor,
  planEmbeddingRanking,
  readEmbeddingConfig,
  resolveConfiguredEmbeddingBackend,
} from "../../src/embeddings.js";

const openServers: StubEmbeddingServer[] = [];

async function stubServer(options: StubEmbeddingServerOptions = {}): Promise<StubEmbeddingServer> {
  const server = await startStubEmbeddingServer(options);
  openServers.push(server);
  return server;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe("readEmbeddingConfig", () => {
  it("returns null when no endpoint is configured, which is the default state of every install", () => {
    expect(readEmbeddingConfig({})).toBeNull();
    // A variable set to whitespace is the shape a shell export with an empty value leaves behind;
    // treating it as configured would turn a typo into a hard error on a healthy install.
    expect(readEmbeddingConfig({ [EMBED_URL_ENV]: "   " })).toBeNull();
  });

  it("names the missing model variable rather than failing obscurely at request time", () => {
    expect(() => readEmbeddingConfig({ [EMBED_URL_ENV]: "http://localhost:4000/v1/embeddings" })).toThrow(EmbeddingConfigError);
    expect(() => readEmbeddingConfig({ [EMBED_URL_ENV]: "http://localhost:4000/v1/embeddings" })).toThrow(`${EMBED_MODEL_ENV} is required`);
  });

  it("rejects a URL that is not a URL, and one that is not http(s)", () => {
    expect(() => readEmbeddingConfig({ [EMBED_URL_ENV]: "not a url", [EMBED_MODEL_ENV]: "m" })).toThrow(EmbeddingConfigError);
    expect(() => readEmbeddingConfig({ [EMBED_URL_ENV]: "file:///etc/passwd", [EMBED_MODEL_ENV]: "m" })).toThrow(/http\(s\)/u);
  });

  it("carries the api key only when one is set", () => {
    const withoutKey = readEmbeddingConfig({ [EMBED_URL_ENV]: "http://h/v1/embeddings", [EMBED_MODEL_ENV]: "m" });
    expect(withoutKey?.apiKey).toBeUndefined();
    const withKey = readEmbeddingConfig({ [EMBED_URL_ENV]: "http://h/v1/embeddings", [EMBED_MODEL_ENV]: "m", [EMBED_API_KEY_ENV]: "sekrit" });
    expect(withKey?.apiKey).toBe("sekrit");
  });
});

describe("resolveConfiguredEmbeddingBackend", () => {
  it("returns null rather than throwing on a broken configuration, because its callers all fail open", () => {
    // `readEmbeddingConfig` throws here; recall and the token-goat seam must still rank lexically
    // instead of failing a command whose real work succeeded.
    expect(resolveConfiguredEmbeddingBackend({ [EMBED_URL_ENV]: "http://localhost:4000/v1/embeddings" })).toBeNull();
    expect(resolveConfiguredEmbeddingBackend({})).toBeNull();
  });
});

describe("endpointLabelFor", () => {
  it("reports host only, so neither a path, a query string, nor userinfo can reach a printed diagnostic", () => {
    expect(endpointLabelFor("https://user:pass@api.example.com:8443/v1/embeddings?key=abc")).toBe("api.example.com:8443");
  });
});

describe("the HTTP backend against a real local endpoint", () => {
  it("embeds a single text and a batch in one request each", async () => {
    const server = await stubServer();
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "test-model" });

    const single = await backend.embed("hello");
    expect(Array.from(single)).toEqual(defaultVector("hello").map((n) => Math.fround(n)));

    const batch = await backend.embedBatch(["alpha", "beta", "gamma"]);
    expect(batch).toHaveLength(3);
    // Two calls, three texts in the second: the batch is one round trip, not one per fact.
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body.input).toEqual(["alpha", "beta", "gamma"]);
    expect(server.requests[1]?.body.model).toBe("test-model");
  });

  it("pairs vectors by the response's index field, not by array position", async () => {
    // The failure this pins is silent: an endpoint answering out of order would attach every fact
    // its neighbour's vector, producing wrong similarity forever with no error anywhere.
    const server = await stubServer({ reverseOrder: true });
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "test-model" });

    const vectors = await backend.embedBatch(["alpha", "beta", "gamma"]);

    expect(Array.from(vectors[0] ?? [])).toEqual(defaultVector("alpha").map((n) => Math.fround(n)));
    expect(Array.from(vectors[1] ?? [])).toEqual(defaultVector("beta").map((n) => Math.fround(n)));
    expect(Array.from(vectors[2] ?? [])).toEqual(defaultVector("gamma").map((n) => Math.fround(n)));
  });

  it("sends Authorization only when a key is configured", async () => {
    const anonymous = await stubServer();
    await createHttpEmbeddingBackend({ url: anonymous.url, model: "m" }).embed("x");
    expect(anonymous.requests[0]?.authorization).toBeUndefined();

    const authenticated = await stubServer();
    await createHttpEmbeddingBackend({ url: authenticated.url, model: "m", apiKey: "sk-test-key" }).embed("x");
    expect(authenticated.requests[0]?.authorization).toBe("Bearer sk-test-key");
  });

  it("never puts the api key in an error, even when the endpoint echoes it back in its body", async () => {
    const server = await stubServer({ status: 500 });
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "m", apiKey: "sk-test-key" });

    await expect(backend.embed("x")).rejects.toThrow(EmbeddingRequestError);
    // The stub echoes the Authorization header into its error body on purpose: real gateways do,
    // and forwarding a failing endpoint's body is exactly how a key ends up in a pasted traceback.
    await expect(backend.embed("x")).rejects.toThrow(/HTTP 500/u);
    await expect(backend.embed("x")).rejects.not.toThrow(/sk-test-key/u);
  });

  it("surfaces a non-200 as a typed failure naming the status", async () => {
    const server = await stubServer({ status: 429 });
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "m" });
    await expect(backend.embedBatch(["x"])).rejects.toThrow(/HTTP 429/u);
  });

  it("surfaces a body that is not JSON, and one that is JSON of the wrong shape", async () => {
    const notJson = await stubServer({ rawBody: "<html>gateway</html>" });
    await expect(createHttpEmbeddingBackend({ url: notJson.url, model: "m" }).embed("x")).rejects.toThrow(/not JSON/u);

    const noData = await stubServer({ rawBody: JSON.stringify({ object: "list" }) });
    await expect(createHttpEmbeddingBackend({ url: noData.url, model: "m" }).embed("x")).rejects.toThrow(/`data` array/u);
  });

  it("rejects a data array that is not one usable entry per input", async () => {
    const wrongCount = await stubServer({ dataOverride: () => [{ index: 0, embedding: [1, 2] }] });
    await expect(createHttpEmbeddingBackend({ url: wrongCount.url, model: "m" }).embedBatch(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/u);

    const notAnArray = await stubServer({ dataOverride: () => [{ index: 0, embedding: "nope" }] });
    await expect(createHttpEmbeddingBackend({ url: notAnArray.url, model: "m" }).embed("a")).rejects.toThrow(/not \{ index/u);

    const nonFinite = await stubServer({ dataOverride: () => [{ index: 0, embedding: [1, null] }] });
    await expect(createHttpEmbeddingBackend({ url: nonFinite.url, model: "m" }).embed("a")).rejects.toThrow(/not \{ index/u);

    const noIndex = await stubServer({ dataOverride: () => [{ embedding: [1, 2] }] });
    await expect(createHttpEmbeddingBackend({ url: noIndex.url, model: "m" }).embed("a")).rejects.toThrow(/not \{ index/u);

    const repeated = await stubServer({ dataOverride: () => [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] });
    await expect(createHttpEmbeddingBackend({ url: repeated.url, model: "m" }).embedBatch(["a", "b"])).rejects.toThrow(/repeated index 0/u);

    const outOfRange = await stubServer({ dataOverride: () => [{ index: 7, embedding: [1] }] });
    await expect(createHttpEmbeddingBackend({ url: outOfRange.url, model: "m" }).embed("a")).rejects.toThrow(/index 7 for a batch of 1/u);

    // Ragged dimensions are the one malformed case that would otherwise pass silently: stored, then
    // compared by `cosineSimilarity` over the shorter length, yielding a confident wrong number.
    const ragged = await stubServer({ dataOverride: () => [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1, 2, 3] }] });
    await expect(createHttpEmbeddingBackend({ url: ragged.url, model: "m" }).embedBatch(["a", "b"])).rejects.toThrow(/mixed vector dimensions/u);
  });

  it("aborts a stalled endpoint at its own timeout rather than waiting on it", async () => {
    const server = await stubServer({ delayMs: 5_000 });
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "m" }, { timeoutMs: 50 });

    const started = Date.now();
    await expect(backend.embed("x")).rejects.toThrow(/timed out after 50ms/u);
    // The abort is what matters, not the exact number: without `AbortSignal.timeout` the socket
    // stays open and keeps Node's event loop alive long after the caller gave up.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("reports an endpoint nobody is listening on as unreachable, not as a crash", async () => {
    const server = await stubServer();
    await server.close();
    openServers.length = 0;
    const backend = createHttpEmbeddingBackend({ url: server.url, model: "m" }, { timeoutMs: 500 });
    await expect(backend.embed("x")).rejects.toThrow(EmbeddingRequestError);
    await expect(backend.embed("x")).rejects.toThrow(/could not be reached/u);
  });

  it("returns an empty array for an empty batch without touching the network", async () => {
    const server = await stubServer();
    const vectors = await createHttpEmbeddingBackend({ url: server.url, model: "m" }).embedBatch([]);
    expect(vectors).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });
});

describe("planEmbeddingRanking", () => {
  const configured = { [EMBED_URL_ENV]: "http://127.0.0.1:1/v1/embeddings", [EMBED_MODEL_ENV]: "model-b" };

  it("is a silent no-op when embeddings are off -- the default state is not a problem to report", () => {
    const plan = planEmbeddingRanking(null, {});
    expect(plan.backend).toBeNull();
    expect(plan.incomparable).toBeNull();
  });

  it("wires the backend when the store has no vectors yet, or when the models agree", () => {
    expect(planEmbeddingRanking(null, configured).backend).not.toBeNull();
    expect(planEmbeddingRanking({ model: "model-b", dimension: 4 }, configured).backend).not.toBeNull();
  });

  it("withholds the backend when the store's vectors came from another model, and says how to fix it", () => {
    // Withheld rather than used-with-care because `cosineSimilarity` cannot detect the mismatch: it
    // compares over the shorter of the two lengths and answers confidently either way.
    const plan = planEmbeddingRanking({ model: "model-a", dimension: 4 }, configured);
    expect(plan.backend).toBeNull();
    expect(plan.incomparable).toMatch(/model-a/u);
    expect(plan.incomparable).toMatch(/mem embed --all/u);
  });
});
