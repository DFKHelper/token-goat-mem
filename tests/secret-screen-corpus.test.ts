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

describe("secret-screen corpus: kebab and snake identifiers with short number segments pass", () => {
  it.each([
    { name: "kebab id with a version segment", text: "feature-flag-new-checkout-flow-experiment-variant-v2" },
    { name: "kebab deploy id with digit segments", text: "deploy-prod-eu-west-1-blue-green-release-candidate-2" },
    { name: "kebab id with a year", text: "feature-flag-2026-rollout-for-search-ranking-v2" },
    { name: "snake id with a year", text: "migration_plan_2026_for_the_billing_service_v3" },
  ])("passes $name", ({ text }) => {
    expect(patternNamesFor(text)).toEqual([]);
  });
});

describe("secret-screen corpus: random-looking hyphenated tokens stay flagged", () => {
  it.each([
    { name: "hyphen-joined base64 groups", text: "Xk9Pq2LmZ8-vB3nRt7YwQ1-aS5dFg6HjK4-mN8pQ2rT" },
    { name: "lowercase hex groups", text: "3f9a-1c7e-2b8d-04f6-5a93-ce17-b240-9d1f-77aa" },
    { name: "lowercase letter-digit groups", text: "a8f3k2-9xq7m1-p4z6w0-h2j5n8-c1v3b7-t9y4u6" },
    { name: "digits glued into words", text: "subagent-git2-discard-prohibition9-and-more-words" },
    { name: "random letter groups joined by four-digit numbers", text: "the token is xqztkmvb-4821-mbvwhjkd-9034-hjkdnqrs-7765-pqlzxcvb" },
    { name: "long consonant-heavy groups joined by a non-year number", text: "token zzqkxmwvbnhydlrtpgfsczqx-1234-abcdefghijklmnopqrstuvwx-5" },
    { name: "vowel-less letter groups joined by ordinals", text: "xqztkmvb-12-mbvwhjkd-34-hjkdnqrs" },
    { name: "more than two number segments", text: "feature-flag-1-rollout-2-for-search-3-ranking-quality" },
  ])("flags $name as generic-high-entropy-token", ({ text }) => {
    expect(patternNamesFor(text)).toContain(GENERIC);
  });
});

describe("secret-screen corpus: a uuid beside a credential keyword is flagged whatever its entropy", () => {
  const LOW_ENTROPY_UUID = "11111111-1111-1111-1111-111111111111";

  it.each([
    { name: "api key label", text: `api key ${LOW_ENTROPY_UUID}` },
    { name: "token label", text: `token: ${LOW_ENTROPY_UUID}` },
    { name: "keyword after the uuid", text: `${LOW_ENTROPY_UUID} is the staging password` },
  ])("flags a low-entropy uuid in $name", ({ text }) => {
    expect(patternNamesFor(text)).toContain(GENERIC);
  });

  it("passes a bare low-entropy uuid with no credential keyword", () => {
    expect(patternNamesFor(`the session id is ${LOW_ENTROPY_UUID}`)).toEqual([]);
    expect(patternNamesFor(`fact ${LOW_ENTROPY_UUID} is the canonical one`)).toEqual([]);
  });

  it("still exempts a low-entropy uuid in a transcript sourceRef under a credential-named directory", () => {
    const sourceRef = `/home/x/.claude/projects/token-goat-mem/${LOW_ENTROPY_UUID}.jsonl#turn3`;
    expect(screenForSecrets({ text: `the session id is ${LOW_ENTROPY_UUID}`, sourceRef }, [])).toEqual([]);
  });
});

describe("secret-screen corpus: a canonical-length hex value right after a credential keyword is flagged", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const HEX40 = "0123456789abcdef0123456789abcdef01234567";

  it.each([
    { name: "api key label", text: `api key ${HEX32}` },
    { name: "token label", text: `token: ${HEX32}` },
    { name: "password sentence", text: `the staging password is ${HEX32}` },
    { name: "forty hex after a secret", text: `client secret ${HEX40}` },
  ])("flags $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).not.toHaveLength(0);
  });

  it.each([
    { name: "md5 checksum mention", text: `md5 checksum ${HEX32}` },
    { name: "git object id", text: `git object ${HEX40}` },
    { name: "hash with a credential word far earlier in the sentence", text: `the token cache was cleared long ago and now the file hash is ${HEX32}` },
  ])("passes $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).toEqual([]);
  });
});

describe("secret-screen corpus: a bare uuid anchor argument is read with the fact text's credential words", () => {
  const UUID = "3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b";
  const LOW_UUID = "11111111-1111-1111-1111-111111111111";
  const CREDENTIAL_TEXT = "the api key lives in config.json";
  const BACKSLASH = String.fromCharCode(92);

  it.each([
    { name: "a high-entropy uuid", anchor: `file-contains config.json ${UUID}` },
    { name: "a low-entropy uuid", anchor: `file-contains config.json ${LOW_UUID}` },
  ])("flags $name that is only in the anchor", ({ anchor }) => {
    expect(screenForSecrets({ text: CREDENTIAL_TEXT, anchor }, []).map((match) => match.field)).toContain("anchor");
  });

  it("passes a low-entropy uuid anchor argument when nothing in the fact names a credential", () => {
    expect(screenForSecrets({ text: "the build config lives in config.json", anchor: `file-contains config.json ${LOW_UUID}` }, [])).toEqual([]);
  });

  it.each([
    { name: "a POSIX path segment", anchor: `file-exists logs/${UUID}/out.txt` },
    { name: "a Windows path segment", anchor: `file-exists logs${BACKSLASH}${UUID}${BACKSLASH}out.txt` },
    { name: "a uuid filename", anchor: `file-exists ${LOW_UUID}.jsonl` },
  ])("still exempts $name in the anchor under credential text", ({ anchor }) => {
    expect(screenForSecrets({ text: CREDENTIAL_TEXT, anchor }, [])).toEqual([]);
  });

  it("still exempts a scan-session style transcript sourceRef under credential text", () => {
    const sourceRef = `C:${BACKSLASH}Users${BACKSLASH}x${BACKSLASH}.claude${BACKSLASH}projects${BACKSLASH}p${BACKSLASH}${UUID}.jsonl#turn3`;
    expect(screenForSecrets({ text: CREDENTIAL_TEXT, sourceRef }, [])).toEqual([]);
  });
});
