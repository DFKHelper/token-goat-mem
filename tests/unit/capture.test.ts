import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openStorage } from "../../src/storage.js";
import {
  captureExplicit,
  captureSuggested,
  screenForSecrets,
  loadAllowlist,
  SecretDetectedError,
  InvalidAnchorError,
  CaptureValidationError,
} from "../../src/capture.js";

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

function epoch(): string {
  return (db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string }).value;
}

function auditEvents(factId: string): string[] {
  return (db.prepare("SELECT event FROM audit_log WHERE fact_id = ?").all(factId) as { event: string }[]).map(
    (row) => row.event
  );
}

describe("captureExplicit", () => {
  it("stores the fact active, source_type=user, confidence=1, and bumps the epoch", () => {
    const { fact } = captureExplicit(db, { text: "uses pnpm not npm", kind: "preference", root });
    expect(fact.status).toBe("active");
    expect(fact.source_type).toBe("user");
    expect(fact.confidence).toBe(1);
    expect(epoch()).toBe("1");
    expect(auditEvents(fact.id)).toEqual(["capture_explicit"]);

    const row = db.prepare("SELECT status, source_type FROM facts WHERE id = ?").get(fact.id) as {
      status: string;
      source_type: string;
    };
    expect(row.status).toBe("active");
    expect(row.source_type).toBe("user");
  });

  it("normalizes subject (via storage.ts's normalizeSubject) and requires subject+value to be paired", () => {
    const { fact } = captureExplicit(db, {
      text: "uses pnpm",
      kind: "preference",
      subject: "  Package Manager  ",
      value: "pnpm",
      root,
    });
    // capture.ts trims and passes subject through untouched; storage.ts's insertFact is the single
    // place that normalizes it (trim + lowercase, no whitespace collapsing) -- see src/storage.ts.
    expect(fact.subject).toBe("package manager");
    expect(fact.value).toBe("pnpm");

    expect(() => captureExplicit(db, { text: "orphan subject", kind: "fact", subject: "x", root })).toThrow(
      CaptureValidationError
    );
    expect(() => captureExplicit(db, { text: "orphan value", kind: "fact", value: "x", root })).toThrow(
      CaptureValidationError
    );
  });

  it("records scopeRoot for project/path scope but not for global scope", () => {
    const globalFact = captureExplicit(db, { text: "global pref", kind: "preference", root }).fact;
    expect(globalFact.scopeRoot ?? null).toBeNull();

    const projectFact = captureExplicit(db, { text: "project fact", kind: "fact", scope: "project", root }).fact;
    expect(projectFact.scopeRoot).toBe(root);
  });

  it("rejects fact text over the length cap", () => {
    expect(() => captureExplicit(db, { text: "x".repeat(501), kind: "fact", root })).toThrow(CaptureValidationError);
  });

  it("rejects an invalid kind", () => {
    expect(() =>
      // @ts-expect-error -- intentionally invalid kind to exercise runtime validation
      captureExplicit(db, { text: "bad kind", kind: "opinion", root })
    ).toThrow(CaptureValidationError);
  });

  it("accepts a syntactically valid anchor and stores it verbatim", () => {
    const { fact } = captureExplicit(db, {
      text: "uses pnpm lockfile",
      kind: "fact",
      anchor: "file-newer-than pnpm-lock.yaml package-lock.json",
      root,
    });
    expect(fact.anchor).toBe("file-newer-than pnpm-lock.yaml package-lock.json");
  });

  it("rejects an unknown anchor predicate", () => {
    expect(() => captureExplicit(db, { text: "bad anchor", kind: "fact", anchor: "rm -rf /", root })).toThrow(
      InvalidAnchorError
    );
  });

  it("rejects an anchor with the wrong argument count", () => {
    expect(() =>
      captureExplicit(db, { text: "bad arity", kind: "fact", anchor: "file-newer-than only-one-arg", root })
    ).toThrow(InvalidAnchorError);
  });

  it("blocks a fact containing a known secret pattern and persists nothing", () => {
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

  it("allows a screened value once it is added to .mem/allowlist", () => {
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

describe("captureSuggested", () => {
  it("always stores pending, regardless of requested confidence", () => {
    const { fact } = captureSuggested(db, {
      text: "staging DB host is prod-staging-db-1",
      kind: "fact",
      confidence: 0.99,
      root,
    });
    expect(fact.status).toBe("pending");
    expect(fact.confidence).toBeLessThanOrEqual(0.6);
  });

  it("defaults source_type to derived (the more heavily quarantined option) when omitted", () => {
    const { fact } = captureSuggested(db, { text: "prefers 2-space indent", kind: "preference", root });
    expect(fact.source_type).toBe("derived");
    expect(fact.status).toBe("pending");
  });

  it("keeps a derived-source fact pending even when the caller supplies sourceType user", () => {
    const { fact } = captureSuggested(db, {
      text: "user mentioned this in passing",
      kind: "preference",
      sourceType: "user",
      root,
    });
    expect(fact.source_type).toBe("user");
    expect(fact.status).toBe("pending");
  });

  it("is also secret-screened before writing", () => {
    expect(() =>
      captureSuggested(db, { text: "found token sk-ant-abcdefghijklmnopqrstuvwxyz012345", kind: "fact", root })
    ).toThrow(SecretDetectedError);
  });
});

describe("screenForSecrets", () => {
  it("does not false-positive on a pure-hex git SHA", () => {
    const matches = screenForSecrets(
      { text: "fixed in commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
      []
    );
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
