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

describe("secret-screen corpus: a hex value is read with the subject and text that label it", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";

  it.each([
    { name: "a credential subject", fields: { text: "x", subject: "api key", value: HEX32 } },
    { name: "a credential word in the text", fields: { text: "the deploy token for staging", subject: "deploy-target", value: HEX32 } },
  ])("flags a bare hex value under $name", ({ fields }) => {
    expect(screenForSecrets(fields, []).map((match) => match.field)).toContain("value");
  });

  it.each([
    { name: "a neutral subject and text", fields: { text: "x", subject: "build output", value: HEX32 } },
    { name: "a commit subject", fields: { text: "the release build", subject: "release commit", value: "0123456789abcdef0123456789abcdef01234567" } },
  ])("passes a bare hex value under $name", ({ fields }) => {
    expect(screenForSecrets(fields, [])).toEqual([]);
  });
});

describe("secret-screen corpus: a hex value is read against a credential keyword anywhere in its sentence or the line before", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const HEX40 = "0123456789abcdef0123456789abcdef01234567";

  it.each([
    { name: "a keyword four words back", text: `the api key was then set to ${HEX32}` },
    { name: "a keyword ten words back", text: `The deploy pipeline signing key was last rotated by the platform team to ${HEX32}` },
    { name: "a keyword on the previous line", text: `api key:\n${HEX32}` },
  ])("flags $name", ({ text }) => {
    expect(screenForSecrets({ text }, []).map((match) => match.patternName)).toContain(GENERIC);
  });

  it.each([
    { name: "a commit mention", text: `commit ${HEX40} fixed the parser` },
    { name: "a commit nearer than an earlier token word", text: `the token refresh bug was fixed in commit ${HEX40}` },
    { name: "a keyword two lines back", text: `api key rotated\nsee the notes\nmd5 of the build ${HEX32}` },
  ])("passes $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).toEqual([]);
  });

  it.each([
    { name: "an anchor path segment", fields: { text: "the api key cache", anchor: `file-exists a/${HEX32}` } },
    { name: "a sourceRef path directory", fields: { text: "the api key cache", sourceRef: `docs/${HEX32}/notes.md:3` } },
  ])("still exempts a hex in $name", ({ fields }) => {
    expect(screenForSecrets(fields, [])).toEqual([]);
  });
});

describe("secret-screen corpus: zero-width characters inside a hex value do not hide it", () => {
  const HALF = "0123456789abcdef";

  it.each([
    ["U+200B", "​"],
    ["U+200C", "‌"],
    ["U+200D", "‍"],
    ["U+FEFF", "﻿"],
    ["U+2060", "⁠"],
  ])("flags a hex split by %s", (_name, zeroWidth) => {
    const text = `API key: ${HALF}${zeroWidth}${HALF}`;
    expect(screenForSecrets({ text }, []).map((match) => match.patternName)).toContain(GENERIC);
  });

  it("passes a zero-width character in text with no hex or credential word", () => {
    expect(screenForSecrets({ text: "the build​ step ran" }, [])).toEqual([]);
  });
});

describe("secret-screen corpus: directional marks, format characters and variation selectors do not hide a secret", () => {
  const HALF = "0123456789abcdef";
  const GITHUB_TOKEN_HEAD = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ";
  const GITHUB_TOKEN_TAIL = "0123456789";

  it.each([
    ["U+200E", 0x200e],
    ["U+200F", 0x200f],
    ["U+202A", 0x202a],
    ["U+202E", 0x202e],
    ["U+2061", 0x2061],
    ["U+2066", 0x2066],
    ["U+2069", 0x2069],
    ["U+180E", 0x180e],
    ["U+061C", 0x61c],
    ["U+FE00", 0xfe00],
    ["U+FE0F", 0xfe0f],
  ])("flags a hex split by %s", (_name, codePoint) => {
    const text = `API key: ${HALF}${String.fromCodePoint(codePoint)}${HALF}`;
    expect(patternNamesFor(text)).toContain(GENERIC);
  });

  it.each([
    ["U+200E", 0x200e],
    ["U+202E", 0x202e],
    ["U+2066", 0x2066],
    ["U+180E", 0x180e],
    ["U+FE0F", 0xfe0f],
  ])("flags a github token split by %s", (_name, codePoint) => {
    const text = `${GITHUB_TOKEN_HEAD}${String.fromCodePoint(codePoint)}${GITHUB_TOKEN_TAIL}`;
    expect(patternNamesFor(text)).toContain("github-token");
  });

  it("passes an emoji variation selector in text with no hex or credential word", () => {
    expect(screenForSecrets({ text: `the build step ran ${String.fromCodePoint(0x2764, 0xfe0f)}` }, [])).toEqual([]);
  });
});

describe("secret-screen corpus: a hex value is read against a credential keyword just after it", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const HEX40 = "0123456789abcdef0123456789abcdef01234567";

  it.each([
    { name: "a trailing production API key label", text: `${HEX32} is the production API key` },
    { name: "a trailing token label in the past tense", text: `${HEX32} was the token for staging` },
    { name: "a trailing label on a forty-hex value", text: `${HEX40} is the webhook signing secret` },
    { name: "a trailing label on the next line", text: `${HEX32}\nthat is the password` },
  ])("flags $name", ({ text }) => {
    expect(patternNamesFor(text)).toContain(GENERIC);
  });

  it.each([
    { name: "a hash mention before and a commit sentence after", text: `${HEX40} is the commit that fixed the parser` },
    { name: "a keyword beyond the window", text: `${HEX32} appears in the release notes written by the platform team for the token refresh work` },
    { name: "a hash word right after the hex before a keyword", text: `${HEX32} md5 checksum of the secret santa list` },
    { name: "a commit mention before and a keyword in the fix description", text: `commit ${HEX40} fixed the token parser` },
    { name: "a keyword on a later line", text: `${HEX32}\nsee the notes\nthe api key rotated` },
  ])("passes $name", ({ text }) => {
    expect(screenForSecrets({ text }, [])).toEqual([]);
  });
});
