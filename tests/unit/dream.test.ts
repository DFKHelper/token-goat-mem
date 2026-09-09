/**
 * Unit tests for src/dream.ts.
 *
 * `fetchImpl` is injected rather than the network being mocked globally: what needs proving is this
 * module's own request shaping and, far more importantly, its checking of whatever comes back. The
 * endpoint is a model, so its output is the untrusted input here — every test below is really a test
 * that a bad reply produces a dropped candidate or a named error, never a plausible-looking fact.
 */

import { describe, expect, it } from "vitest";

import {
  dream,
  DreamConfigError,
  DreamRequestError,
  DREAM_API_KEY_ENV,
  DREAM_MODEL_ENV,
  DREAM_URL_ENV,
  MAX_DREAM_FACTS,
  readDreamConfig,
  type DreamConfig,
} from "../../src/dream.js";
import type { Fact } from "../../src/types.js";

const CONFIG: DreamConfig = { url: "https://models.example.com/v1/chat/completions", model: "test-model" };

function makeFact(id: string, text: string, capturedAt = "2026-01-01T00:00:00.000Z"): Fact {
  return {
    id,
    text,
    kind: "fact",
    subject: null,
    value: null,
    scope: "global",
    source_type: "user",
    source_ref: null,
    captured_at: capturedAt,
    anchor: null,
    status: "active",
    confidence: 1,
    embedding: null,
  };
}

const FACTS = [
  makeFact("f1", "releases are cut by hand from a laptop"),
  makeFact("f2", "the deploy script is run manually after each tag"),
  makeFact("f3", "there is no CI workflow in the repository"),
];

/** A fetch that answers every request with `content` as the assistant message. */
function replyWith(content: string, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function candidatesJson(candidates: unknown): string {
  return JSON.stringify({ candidates });
}

describe("readDreamConfig", () => {
  it("is off when the URL is unset, which is the normal state and not an error", () => {
    expect(readDreamConfig({})).toBeNull();
    expect(readDreamConfig({ [DREAM_MODEL_ENV]: "some-model" })).toBeNull();
  });

  it("refuses a configuration that is set but unusable rather than silently disabling itself", () => {
    // Half-configured is a typo, not a decision to run without dreaming -- reporting it as "off"
    // would leave the user believing the endpoint was being called.
    //
    // Each case asserts the *message*, not just the class: with the model left unset, every one of
    // these would throw a DreamConfigError for the missing model regardless of whether the guard
    // under test exists, so a class-only assertion passes on a build where the scheme check has
    // been deleted. The model is supplied here so the named guard is the only thing that can fire.
    const model = { [DREAM_MODEL_ENV]: "m" };
    expect(() => readDreamConfig({ ...model, [DREAM_URL_ENV]: "not a url" })).toThrow(DreamConfigError);
    expect(() => readDreamConfig({ ...model, [DREAM_URL_ENV]: "not a url" })).toThrow(/not a valid URL/u);
    expect(() => readDreamConfig({ ...model, [DREAM_URL_ENV]: "ftp://models.example.com" })).toThrow(
      /must be an http\(s\) URL/u
    );
    expect(() => readDreamConfig({ [DREAM_URL_ENV]: "https://models.example.com" })).toThrow(
      new RegExp(`${DREAM_MODEL_ENV} is required`, "u")
    );
  });

  it("carries the key only when one was given", () => {
    const base = { [DREAM_URL_ENV]: "https://models.example.com/v1/chat/completions", [DREAM_MODEL_ENV]: "m" };
    expect(readDreamConfig(base)?.apiKey).toBeUndefined();
    expect(readDreamConfig({ ...base, [DREAM_API_KEY_ENV]: "sk-x" })?.apiKey).toBe("sk-x");
  });
});

describe("dream", () => {
  it("returns candidates with the ids of the facts they cite", async () => {
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(candidatesJson([{ text: "deploys are manual", kind: "fact", supports: [1, 2] }])),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).toBe("deploys are manual");
    // Ids, not indices: a citation is only useful if `mem show` can follow it.
    expect(result.candidates[0]?.supports).toEqual(["f1", "f2"]);
  });

  it("sends no request at all when there is nothing to cross-reference", async () => {
    // One fact cannot produce a cross-fact inference, so calling the endpoint would be paying for an
    // answer that can only be empty.
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await dream([FACTS[0] as Fact], CONFIG, { fetchImpl: spy });
    expect(called).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it("drops a candidate that cites fewer than two facts", async () => {
    // A statement following from one fact is a restatement of it. The cross-fact step is the entire
    // reason to spend a model call, so a single-citation candidate is not a weaker inference -- it
    // is not an inference.
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(candidatesJson([{ text: "releases are manual", kind: "fact", supports: [1] }])),
    });
    expect(result.candidates).toEqual([]);
  });

  it("drops a candidate citing a fact that was never sent", async () => {
    // A citation the reader cannot follow looks like grounding and is not. Out-of-range indices are
    // dropped rather than clamped: clamping would silently re-point the claim at a different fact.
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(candidatesJson([{ text: "invented", kind: "fact", supports: [1, 99] }])),
    });
    expect(result.candidates).toEqual([]);
  });

  it("drops a candidate that merely restates a fact already in the store", async () => {
    // The prompt forbids this twice; the guarantee must not depend on the model having listened.
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(
        candidatesJson([{ text: "There is no CI workflow in the repository.", kind: "fact", supports: [1, 2] }])
      ),
    });
    expect(result.candidates).toEqual([]);
  });

  it("drops a candidate claiming a kind the store does not have", async () => {
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(candidatesJson([{ text: "something", kind: "insight", supports: [1, 2] }])),
    });
    expect(result.candidates).toEqual([]);
  });

  it("keeps the good candidates when one element of the reply is malformed", async () => {
    // One bad element is a model being imprecise, not an endpoint being broken -- discarding the
    // whole run would make the command's usefulness depend on the model's worst output.
    const result = await dream(FACTS, CONFIG, {
      fetchImpl: replyWith(
        candidatesJson([
          "not an object",
          { text: "deploys are manual", kind: "fact", supports: [1, 3] },
          { kind: "fact", supports: [1, 2] },
        ])
      ),
    });
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(["deploys are manual"]);
  });

  it("accepts a reply wrapped in a code fence", async () => {
    // Bare JSON is what the prompt asks for and a stray fence is the commonest deviation; failing
    // the run over it would be brittle for no gain.
    const fenced = "```json\n" + candidatesJson([{ text: "deploys are manual", kind: "fact", supports: [1, 2] }]) + "\n```";
    const result = await dream(FACTS, CONFIG, { fetchImpl: replyWith(fenced) });
    expect(result.candidates).toHaveLength(1);
  });

  it("reports an endpoint failure by status without echoing its body", async () => {
    // A failing endpoint's body routinely echoes request headers back, which is the one place an API
    // key would otherwise reach a user-visible error.
    const failing = (async () => new Response("Authorization: Bearer sk-secret", { status: 500 })) as unknown as typeof fetch;
    await expect(dream(FACTS, { ...CONFIG, apiKey: "sk-secret" }, { fetchImpl: failing })).rejects.toThrow(
      /returned HTTP 500/u
    );
    await expect(dream(FACTS, { ...CONFIG, apiKey: "sk-secret" }, { fetchImpl: failing })).rejects.not.toThrow(
      /sk-secret/u
    );
  });

  it("names the failure when the reply is not the expected shape", async () => {
    const noJson = replyWith("I could not find any inferences, sorry.");
    await expect(dream(FACTS, CONFIG, { fetchImpl: noJson })).rejects.toThrow(DreamRequestError);
    const noCandidates = replyWith('{"results":[]}');
    await expect(dream(FACTS, CONFIG, { fetchImpl: noCandidates })).rejects.toThrow(/no candidates array/u);
  });

  it("sends the newest facts and reports the truncation", async () => {
    // A store larger than the cap must not be silently reasoned over in part.
    const many = Array.from({ length: MAX_DREAM_FACTS + 5 }, (_unused, index) =>
      makeFact(`f${index}`, `fact number ${index}`, `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`)
    );
    const result = await dream(many, CONFIG, { fetchImpl: replyWith(candidatesJson([])) });
    expect(result.sent).toHaveLength(MAX_DREAM_FACTS);
    expect(result.available).toBe(MAX_DREAM_FACTS + 5);
  });

  it("sends no authorization header when no key is configured", async () => {
    // A local endpoint that wants no auth must not receive one, and there is no honest placeholder.
    let headers: Record<string, string> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      headers = (init.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: candidatesJson([]) } }] }));
    }) as unknown as typeof fetch;
    await dream(FACTS, CONFIG, { fetchImpl: capture });
    expect(headers["authorization"]).toBeUndefined();
    await dream(FACTS, { ...CONFIG, apiKey: "sk-x" }, { fetchImpl: capture });
    expect(headers["authorization"]).toBe("Bearer sk-x");
  });
});
