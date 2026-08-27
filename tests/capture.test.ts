import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openStorage } from "../src/storage.js";
import {
  captureExplicit,
  captureSuggested,
  screenForSecrets,
  loadAllowlist,
  SecretDetectedError,
  InvalidAnchorError,
  CaptureValidationError,
} from "../src/capture.js";

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-capture-test-"));
  // storage.ts's insertFact (which capture.ts writes through) needs the full storage schema
  // (facts.epoch, added by ensureStorageSchema's migration) -- openStorage() is what every real
  // `mem` invocation actually opens with (cli.ts's withDb), so tests exercising capture.ts should
  // too, not the narrower db.ts-only openDb().
  db = openStorage(join(root, "mem.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function factRow(id: string): { status: string; source_type: string; confidence: number } {
  return db.prepare("SELECT status, source_type, confidence FROM facts WHERE id = ?").get(id) as {
    status: string;
    source_type: string;
    confidence: number;
  };
}

function auditEvents(factId: string): string[] {
  return (db.prepare("SELECT event FROM audit_log WHERE fact_id = ?").all(factId) as { event: string }[]).map(
    (row) => row.event
  );
}

describe("captureExplicit (happy path)", () => {
  it("stores an active, fully-trusted, user-sourced fact and audits it", () => {
    const { fact } = captureExplicit(db, {
      text: "uses pnpm not npm",
      kind: "preference",
      root,
    });

    expect(fact.status).toBe("active");
    expect(fact.source_type).toBe("user");
    expect(fact.confidence).toBe(1);
    expect(fact.kind).toBe("preference");

    const row = factRow(fact.id);
    expect(row.status).toBe("active");
    expect(row.source_type).toBe("user");
    expect(auditEvents(fact.id)).toEqual(["capture_explicit"]);
  });

  it("pairs subject+value and rejects a lone key", () => {
    const { fact } = captureExplicit(db, {
      text: "uses pnpm",
      kind: "preference",
      subject: "Package Manager",
      value: "pnpm",
      root,
    });
    expect(fact.subject).toBe("package manager");
    expect(fact.value).toBe("pnpm");

    expect(() => captureExplicit(db, { text: "orphan subject", kind: "fact", subject: "x", root })).toThrow(
      CaptureValidationError
    );
    expect(() => captureExplicit(db, { text: "orphan value", kind: "fact", value: "x", root })).toThrow(
      CaptureValidationError
    );
  });

  it("rejects text over the length cap and an unknown kind", () => {
    expect(() => captureExplicit(db, { text: "x".repeat(501), kind: "fact", root })).toThrow(
      CaptureValidationError
    );
    expect(() =>
      // @ts-expect-error -- intentionally invalid kind to exercise runtime validation
      captureExplicit(db, { text: "bad kind", kind: "opinion", root })
    ).toThrow(CaptureValidationError);
  });

  it("accepts a syntactically valid anchor and rejects an unknown/malformed one", () => {
    const { fact } = captureExplicit(db, {
      text: "uses pnpm lockfile",
      kind: "fact",
      anchor: "file-newer-than pnpm-lock.yaml package-lock.json",
      root,
    });
    expect(fact.anchor).toBe("file-newer-than pnpm-lock.yaml package-lock.json");

    expect(() =>
      captureExplicit(db, { text: "bad anchor", kind: "fact", anchor: "rm -rf /", root })
    ).toThrow(InvalidAnchorError);
    expect(() =>
      captureExplicit(db, { text: "bad arity", kind: "fact", anchor: "file-exists a b", root })
    ).toThrow(InvalidAnchorError);
  });

  it("accepts every predicate anchors.ts documents, not just the four ANCHOR_ARITY originally listed", () => {
    // Regression test: ANCHOR_ARITY (capture.ts's syntax gate for mem remember/mem edit --anchor) had
    // drifted out of sync with anchors.ts's actual predicate set, silently rejecting six of the ten
    // documented predicates -- including package-version, the predicate this session just added -- as
    // "unknown predicate" even though anchors.ts fully evaluates them. Each of these must validate.
    const wellFormedAnchors = [
      "file-contains README.md hello",
      "file-not-contains README.md nope",
      "newest-of pnpm-lock.yaml package-lock.json yarn.lock",
      "glob-exists src/**/*.ts",
      "git-branch-is master",
      "package-version package.json better-sqlite3@11",
    ];
    for (const anchor of wellFormedAnchors) {
      const { fact } = captureExplicit(db, { text: `anchored: ${anchor}`, kind: "fact", anchor, root });
      expect(fact.anchor).toBe(anchor);
    }

    // newest-of's variable arity: the minimum (expected + one candidate) must still validate.
    const { fact: minimalNewestOf } = captureExplicit(db, {
      text: "minimal newest-of",
      kind: "fact",
      anchor: "newest-of pnpm-lock.yaml package-lock.json",
      root,
    });
    expect(minimalNewestOf.anchor).toBe("newest-of pnpm-lock.yaml package-lock.json");

    // ...but still enforces its own arity floor (at least 2 args: expected + >=1 candidate).
    expect(() =>
      captureExplicit(db, { text: "bad newest-of arity", kind: "fact", anchor: "newest-of pnpm-lock.yaml", root })
    ).toThrow(InvalidAnchorError);
  });

  it("does not false-positive the generic-high-entropy-token secret heuristic on a plausible long nested-path anchor argument", () => {
    // A perfectly ordinary file-exists anchor over a deeply nested path has no secret in it, but its
    // path argument alone is a >=32-char mixed-case/slash/dash token whose entropy clears the generic
    // heuristic's threshold -- this must not block the capture (same false-positive mechanism, and
    // same slash-scoped fix, as the sourceRef tests below).
    const { fact } = captureExplicit(db, {
      text: "uses this component",
      kind: "fact",
      anchor: "file-exists src/components/very-long-nested-directory-name/AnotherComponent.tsx",
      root,
    });
    expect(fact.anchor).toBe("file-exists src/components/very-long-nested-directory-name/AnotherComponent.tsx");
  });

  it("does not false-positive the generic-high-entropy-token secret heuristic on a plausible long path:line sourceRef", () => {
    // A programmatically-constructed "<path>:<line>" provenance pointer has no secret in it, but a
    // deeply nested path argument alone is a >=32-char mixed-case/slash/dash token whose entropy
    // clears the generic heuristic's threshold -- this must not block the capture.
    const { fact } = captureExplicit(db, {
      text: "uses this component",
      kind: "fact",
      sourceRef: "src/components/very-long-nested-directory-name/AnotherComponent.tsx:42",
      root,
    });
    expect(fact.source_ref).toBe("src/components/very-long-nested-directory-name/AnotherComponent.tsx:42");
  });

  it("still catches a named secret pattern embedded in a sourceRef", () => {
    expect(() =>
      captureExplicit(db, {
        text: "suspicious source ref",
        kind: "fact",
        sourceRef: "AKIAIOSFODNN7EXAMPLE",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("still catches a prefix-less high-entropy secret (no named pattern, no slash) embedded in a sourceRef", () => {
    // sourceRef must not be a blanket exemption from screening: `mem remember --source-ref <ref>`
    // accepts an arbitrary user/agent-supplied string, not just the programmatic "<path>:<line>"
    // pointer the import path produces, so a real unlabeled secret placed there must still be caught.
    expect(() =>
      captureExplicit(db, {
        text: "suspicious source ref",
        kind: "fact",
        sourceRef: "aB3xK9m2ZpQwErTyUiOpAsDfGhJkLzXcVbNm1234",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("still catches a named secret pattern (not just the generic heuristic) embedded in an anchor argument", () => {
    expect(() =>
      captureExplicit(db, {
        text: "suspicious anchor",
        kind: "fact",
        anchor: "file-exists AKIAIOSFODNN7EXAMPLE",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("still catches a prefix-less high-entropy secret (no named pattern, no slash) embedded in an anchor argument", () => {
    // The slash-scoped entropy exemption above must not become a blanket exemption for the whole
    // `anchor` field: a token with no path separator and no recognized SECRET_PATTERNS prefix is
    // exactly the case the generic heuristic exists to catch, and must still be caught here.
    expect(() =>
      captureExplicit(db, {
        text: "suspicious anchor",
        kind: "fact",
        anchor: "file-exists aB3xK9m2ZpQwErTyUiOpAsDfGhJkLzXcVbNm1234",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("stores a fact whose text quotes an ordinary lowercase file path (regression: path-shaped tokens are not high-entropy secrets)", () => {
    // `agent-self-compaction/superman-state` is 36 chars over the 32-char GENERIC_TOKEN floor and
    // scores 3.88 against the 3.8 entropy cutoff purely from directory-name variety -- the exact
    // false positive the anchor/sourceRef exemption already documents, which also blocked writing
    // a perfectly benign decision fact that cited a file path.
    const { fact } = captureExplicit(db, {
      text: "route task scratch to agent-self-compaction/superman-state, durable facts to mem",
      kind: "decision",
      root,
    });
    expect(fact.text).toContain("agent-self-compaction/superman-state");
  });

  it("still catches an AWS secret access key in text even though it contains slashes", () => {
    // The path exemption must be shape-based, never merely slash-based: a real AWS secret access
    // key carries two slashes and is precisely the prefix-less credential the entropy fallback
    // exists to catch. Its uppercase segments must defeat the exemption.
    expect(() =>
      captureExplicit(db, {
        text: "the key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        kind: "fact",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("still catches a mixed-case base64-ish blob containing slashes in text", () => {
    expect(() =>
      captureExplicit(db, {
        text: "token aB3xK9m2/ZpQwErTyUiOp/AsDfGhJkLzXcVbNm1234==",
        kind: "fact",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("does not exempt a single long lowercase run that merely carries one slash", () => {
    // Segment count alone is not enough: `<36-char-run>/x9` does split into two segments that are
    // each lowercase-word-shaped, so the exemption additionally caps the longest unbroken run
    // inside a segment. Real path segments that long are words joined by `-`/`_`/`.`; an unbroken
    // run is the shape of the lowercase random token this entropy fallback exists to catch.
    expect(() =>
      captureExplicit(db, {
        text: "value qwertyuiopasdfghjklzxcvbnmqwertyuiop/x9",
        kind: "fact",
        root,
      })
    ).toThrow(SecretDetectedError);
  });

  it("blocks a fact containing a known secret pattern, persists nothing, and audits the block", () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;

    expect(() =>
      captureExplicit(db, { text: "deploy key is AKIAABCDEFGHIJKLMNOP", kind: "fact", root })
    ).toThrow(SecretDetectedError);

    const after = (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;
    expect(after).toBe(before);

    const blocked = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'capture_explicit_blocked_secret'")
      .get() as { n: number };
    expect(blocked.n).toBe(1);
  });

  it("allows a secret-shaped value once it is added to .mem/allowlist", () => {
    mkdirSync(join(root, ".mem"), { recursive: true });
    writeFileSync(join(root, ".mem", "allowlist"), "AKIAABCDEFGHIJKLMNOP\n");

    const { fact } = captureExplicit(db, {
      text: "deploy key id AKIAABCDEFGHIJKLMNOP",
      kind: "fact",
      root,
    });
    expect(fact.status).toBe("active");
  });
});

describe("captureSuggested -- derived-source facts never auto-promote (design plan Section 3 / S9)", () => {
  it("always stores pending regardless of the requested confidence, and clamps confidence below the trust cap", () => {
    const { fact } = captureSuggested(db, {
      text: "staging DB host is prod-staging-db-1",
      kind: "fact",
      confidence: 0.99,
      root,
    });
    expect(fact.status).toBe("pending");
    expect(fact.confidence).toBeLessThanOrEqual(0.6);
    expect(auditEvents(fact.id)).toEqual(["capture_suggested"]);
  });

  it("defaults source_type to the more heavily quarantined 'derived' when the caller does not specify one", () => {
    const { fact } = captureSuggested(db, { text: "prefers 2-space indent", kind: "preference", root });
    expect(fact.source_type).toBe("derived");
    expect(fact.status).toBe("pending");
  });

  it("stays pending even when the caller explicitly asks for sourceType 'user' -- there is no path from suggested to active", () => {
    const { fact } = captureSuggested(db, {
      text: "user mentioned this in passing",
      kind: "preference",
      sourceType: "user",
      root,
    });
    expect(fact.source_type).toBe("user");
    // The critical invariant under test: whatever sourceType is requested, captureSuggested has
    // exactly one hardcoded status assignment and it is never "active".
    expect(fact.status).toBe("pending");

    const row = factRow(fact.id);
    expect(row.status).toBe("pending");
  });

  it("repeated suggested captures of the same fact never accumulate into an active status (no time/repetition auto-promotion)", () => {
    for (let i = 0; i < 5; i += 1) {
      const { fact } = captureSuggested(db, {
        text: "staging DB host is prod-staging-db-1",
        kind: "fact",
        subject: "staging db host",
        value: "prod-staging-db-1",
        confidence: 0.99,
        root,
      });
      expect(fact.status).toBe("pending");
    }
    const statuses = db.prepare("SELECT DISTINCT status FROM facts").all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(["pending"]);
  });

  it("is secret-screened before writing, same as captureExplicit", () => {
    expect(() =>
      captureSuggested(db, { text: "found token sk-ant-abcdefghijklmnopqrstuvwxyz012345", kind: "fact", root })
    ).toThrow(SecretDetectedError);
  });
});

describe("screenForSecrets", () => {
  it("does not false-positive on a pure-hex git SHA", () => {
    const matches = screenForSecrets({ text: "fixed in commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" }, []);
    expect(matches).toHaveLength(0);
  });

  it("flags a private key block", () => {
    const matches = screenForSecrets({ text: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK..." }, []);
    expect(matches.some((m) => m.patternName === "private-key-block")).toBe(true);
  });

  it("respects an exact-match allowlist entry", () => {
    const matches = screenForSecrets({ text: "key: AKIAABCDEFGHIJKLMNOP" }, ["AKIAABCDEFGHIJKLMNOP"]);
    expect(matches).toHaveLength(0);
  });
});

describe("loadAllowlist", () => {
  it("returns an empty list when .mem/allowlist does not exist", () => {
    expect(loadAllowlist(root)).toEqual([]);
  });

  it("ignores blank lines and # comments", () => {
    mkdirSync(join(root, ".mem"), { recursive: true });
    writeFileSync(join(root, ".mem", "allowlist"), "\n# a comment\nvalue-one\n\nvalue-two\n");
    expect(loadAllowlist(root)).toEqual(["value-one", "value-two"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: keyword-adjacent hex secrets ───────────────────────────────────────────────────────────────────────────

describe("regression: screenForSecrets catches a hex secret sitting next to its own keyword", () => {
  /**
   * A 40-hex-char string is exactly a git SHA-1, so the entropy fallback deliberately allows it --
   * which meant `password: <40 hex chars>` sailed through untouched. Length alone cannot tell a
   * commit hash from a hashed credential; the surrounding keyword can, and that is what this
   * pattern reads.
   */
  const SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  it.each([
    ["password", `password: ${SECRET}`],
    ["api_key", `api_key=${SECRET}`],
    ["api-key", `the api-key is ${SECRET}`],
    ["access token", `access_token ${SECRET}`],
    ["auth token", `auth-token: ${SECRET}`],
    ["signing key", `signing_key => ${SECRET}`],
    ["secret", `SECRET is ${SECRET}`],
  ])("flags a %s carrying a hex value the entropy check alone would clear", (_label, text) => {
    expect(screenForSecrets({ text }, [])).not.toHaveLength(0);
  });

  it("still leaves a bare commit hash alone -- the keyword, not the shape, is what makes it a secret", () => {
    expect(screenForSecrets({ text: `fixed in commit ${SECRET}` }, [])).toHaveLength(0);
  });

  it("no longer waves through a non-canonical-length hex blob just because it is all hex digits", () => {
    // 48 hex chars: not an MD5 (32), SHA-1 (40), or SHA-256 (64), so nothing about it says "hash".
    // The hash allowlist used to be shape-only, which exempted every hex string of any length.
    expect(screenForSecrets({ text: "3f9a1c7e2b8d04f65a93ce17b2408df6e5c1a97b3d2f8e40" }, [])).not.toHaveLength(0);
  });

  it("still exempts each canonical hash length, in either case", () => {
    for (const length of [32, 40, 64]) {
      const lower = "a1b2c3d4".repeat(length / 8);
      expect(screenForSecrets({ text: `hash ${lower}` }, [])).toHaveLength(0);
      expect(screenForSecrets({ text: `hash ${lower.toUpperCase()}` }, [])).toHaveLength(0);
    }
  });
});
