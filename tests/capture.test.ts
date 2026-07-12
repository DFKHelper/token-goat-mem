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
