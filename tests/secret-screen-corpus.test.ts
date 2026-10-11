import { describe, it, expect } from "vitest";
import { screenForSecrets } from "../src/capture.js";

const GENERIC = "generic-high-entropy-token";

function patternNamesFor(text: string): string[] {
  return screenForSecrets({ text }, []).map((match) => match.patternName);
}

describe("secret-screen corpus: benign shapes must pass", () => {
  it.each([
    { name: "uuid inside a path", text: "~/.claude/projects/foo/3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b.jsonl" },
    { name: "session id sentence", text: "the session id is 3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b" },
    { name: "request id label", text: "request id: 3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b" },
    { name: "lowercase kebab id", text: "feature-flag-new-checkout-flow-experiment-variant-b" },
    { name: "git sha", text: "fixed in commit 3f9a1c7e2b8d04f65a93ce17b2408df6e5c1a97b" },
    { name: "semver", text: "released as v0.5.2" },
    { name: "prose about api keys", text: "Store the API key in the environment, never in the repo." },
  ])("passes $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).toEqual([]);
  });
});

describe("secret-screen corpus: secret shapes must be flagged", () => {
  it.each([
    { name: "aws access key id", text: "key is AKIAIOSFODNN7EXAMPLE", pattern: "aws-access-key-id" },
    { name: "github token", text: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", pattern: "github-token" },
    { name: "stripe key", text: "sk_test_corpusfixture0000000000", pattern: "stripe-key" },
  ])("flags $name as $pattern", ({ text, pattern }) => {
    expect(patternNamesFor(text)).toContain(pattern);
  });
});

describe("secret-screen corpus: a uuid next to a credential keyword stays flagged", () => {
  const UUID = "3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b";

  it.each([
    { name: "api key label", text: `api key: ${UUID}` },
    { name: "token assignment", text: `token=${UUID}` },
    { name: "bearer scheme", text: `Bearer ${UUID}` },
    { name: "long-gap sentence", text: `the password for the staging box is ${UUID}` },
    { name: "keyword after the uuid", text: `${UUID} is the staging password` },
    { name: "url userinfo uuid", text: `https://user:${UUID}@h.example.com/x` },
    { name: "pwd label", text: `pwd ${UUID}` },
    { name: "bare uuid with no identifier word", text: UUID },
    { name: "keyword just across a sentence boundary", text: `Password. ${UUID}` },
    { name: "passphrase label", text: `passphrase ${UUID}` },
  ])("flags $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).not.toHaveLength(0);
  });
});

describe("secret-screen corpus: known limitation, benign but kept flagged", () => {
  // Kebab ids with digit segments stay flagged on purpose (tests/capture.test.ts pins the same catch as desired).
  it.each([
    { name: "kebab id with a digit segment", text: "feature-flag-new-checkout-flow-experiment-variant-v2" },
    { name: "kebab deploy id with digit segments", text: "deploy-prod-eu-west-1-blue-green-release-candidate-2" },
  ])("keeps $name flagged as generic-high-entropy-token", ({ text }) => {
    expect(patternNamesFor(text)).toContain(GENERIC);
  });
});
