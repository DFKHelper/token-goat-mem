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
  screenFactFields,
  loadAllowlist,
  SecretDetectedError,
  InvalidAnchorError,
  CaptureValidationError,
} from "../../src/capture.js";

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-capture-test-"));
  // storage.ts's insertFact (which capture.ts writes through) needs the full storage schema (facts.epoch, added by ensureStorageSchema's migration) -- openStorage() is what every real `mem` invocation actually opens with (cli.ts's withDb), so tests exercising capture.ts should too, not the narrower db.ts-only openDb().
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
    // capture.ts trims and passes subject through untouched; storage.ts's insertFact is the single place that normalizes it (trim + lowercase, no whitespace collapsing) -- see src/storage.ts.
    expect(fact.subject).toBe("package manager");
    expect(fact.value).toBe("pnpm");

    // Both orphans trip the same pairing guard, but CaptureValidationError covers 19 distinct messages -- without pinning one, either assertion would be satisfied by any other guard in the function, including the length cap a later test exists to check.
    expect(() => captureExplicit(db, { text: "orphan subject", kind: "fact", subject: "x", root })).toThrow(
      CaptureValidationError
    );
    expect(() => captureExplicit(db, { text: "orphan subject", kind: "fact", subject: "x", root })).toThrow(
      /subject and value must be provided together or not at all/u
    );
    expect(() => captureExplicit(db, { text: "orphan value", kind: "fact", value: "x", root })).toThrow(
      CaptureValidationError
    );
    expect(() => captureExplicit(db, { text: "orphan value", kind: "fact", value: "x", root })).toThrow(
      /subject and value must be provided together or not at all/u
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
    expect(() => captureExplicit(db, { text: "x".repeat(501), kind: "fact", root })).toThrow(/fact text exceeds \d+ characters/u);
  });

  it("rejects an invalid kind", () => {
    expect(() =>
      // @ts-expect-error -- intentionally invalid kind to exercise runtime validation
      captureExplicit(db, { text: "bad kind", kind: "opinion", root })
    ).toThrow(CaptureValidationError);
    expect(() =>
      // @ts-expect-error -- intentionally invalid kind to exercise runtime validation
      captureExplicit(db, { text: "bad kind", kind: "opinion", root })
    ).toThrow(/invalid kind "opinion"/u);
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
    expect(() => captureExplicit(db, { text: "bad anchor", kind: "fact", anchor: "rm -rf /", root })).toThrow(
      /unknown predicate "rm"/u
    );
  });

  it("rejects an anchor with the wrong argument count", () => {
    expect(() =>
      captureExplicit(db, { text: "bad arity", kind: "fact", anchor: "file-newer-than only-one-arg", root })
    ).toThrow(InvalidAnchorError);
    expect(() =>
      captureExplicit(db, { text: "bad arity", kind: "fact", anchor: "file-newer-than only-one-arg", root })
    ).toThrow(/"file-newer-than" expects 2 argument\(s\), got 1/u);
  });

  it("rejects a file-exists anchor whose path traverses above the root", () => {
    expect(() =>
      captureExplicit(db, { text: "escapes via traversal", kind: "fact", anchor: "file-exists ../x", root })
    ).toThrow(InvalidAnchorError);
    expect(() =>
      captureExplicit(db, { text: "escapes via traversal", kind: "fact", anchor: "file-exists ../x", root })
    ).toThrow(/argument "\.\.\/x" must be a path within the anchor root/u);
  });

  it("rejects a glob-exists anchor whose pattern traverses above the root", () => {
    expect(() =>
      captureExplicit(db, { text: "escapes via traversal", kind: "fact", anchor: "glob-exists ../*.ts", root })
    ).toThrow(InvalidAnchorError);
    expect(() =>
      captureExplicit(db, { text: "escapes via traversal", kind: "fact", anchor: "glob-exists ../*.ts", root })
    ).toThrow(/argument "\.\.\/\*\.ts" must be a path within the anchor root/u);
  });

  it("rejects a file-exists anchor naming an absolute path", () => {
    expect(() =>
      captureExplicit(db, { text: "escapes via absolute path", kind: "fact", anchor: "file-exists /etc/passwd", root })
    ).toThrow(InvalidAnchorError);
    expect(() =>
      captureExplicit(db, { text: "escapes via absolute path", kind: "fact", anchor: "file-exists /etc/passwd", root })
    ).toThrow(/argument "\/etc\/passwd" must be a path within the anchor root/u);
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

describe("screenForSecrets: label windows and the sourceRef exemption", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const HEX40 = "0123456789abcdef0123456789abcdef01234567";
  const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("flags a hex whose credential label follows a title abbreviation in the next sentence", () => {
    expect(screenForSecrets({ text: `${HEX32}. Mr. Smith's password.` }, []).length).toBeGreaterThan(0);
  });

  it("does not read a title abbreviation as a word of the bare label", () => {
    expect(screenForSecrets({ text: `${HEX40}. Dr. Jones fixed the login page.` }, [])).toHaveLength(0);
  });

  it("stores a commit hash followed by a sentence that opens with Said and names the label in a later clause", () => {
    expect(screenForSecrets({ text: `Merged ${HEX40}. Said Alice, please fix the password form.` }, [])).toHaveLength(0);
  });

  it("flags a hex followed by a Said sentence whose first clause names the label", () => {
    expect(screenForSecrets({ text: `${HEX32}. Said value is my password` }, []).length).toBeGreaterThan(0);
  });

  it("flags a labelled AWS secret access key in a sourceRef", () => {
    const text = "The AWS secret access key is recorded in the source reference";
    expect(screenForSecrets({ text, sourceRef: AWS_SECRET }, []).length).toBeGreaterThan(0);
  });

  it("flags the same AWS secret access key in the text", () => {
    expect(screenForSecrets({ text: `AWS secret access key ${AWS_SECRET}` }, []).length).toBeGreaterThan(0);
  });

  it("still exempts a mixed-case path:line sourceRef under credential text", () => {
    const sourceRef = "src/components/very-long-nested-directory-name/AnotherComponent.tsx:42";
    expect(screenForSecrets({ text: "the api key cache is described there", sourceRef }, [])).toHaveLength(0);
  });

  it("still exempts a path-shaped sourceRef under credential text", () => {
    const sourceRef = "docs/agent-self-compaction/superman-state-notes.md:12";
    expect(screenForSecrets({ text: "the api key cache is described there", sourceRef }, [])).toHaveLength(0);
  });

  describe("a pointer suffix on a sourceRef under credential text", () => {
    const text = "The AWS secret access key is noted in the source reference";
    const UUID = "1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a";
    const BS = String.fromCharCode(92);

    it.each([`${AWS_SECRET}:1`, `${AWS_SECRET}#turn3`, `${AWS_SECRET}.md:1`, `tok=${AWS_SECRET}:1`])("refuses a mixed-case secret that ends in a pointer: %s", (sourceRef) => {
      expect(screenForSecrets({ text, sourceRef }, []).length).toBeGreaterThan(0);
    });

    it.each([
      `/home/u/.claude/projects/-home-u-proj/${UUID}.jsonl:42`,
      `/home/u/.claude/projects/-home-u-proj/${UUID}.jsonl#turn3`,
      `C:/Users/Zelys/.claude/projects/C--Projects-x/${UUID}.jsonl:42`,
      `C:/Users/Zelys/.claude/projects/C--Projects-x/${UUID.toUpperCase()}.jsonl:42`,
      `C:${BS}Users${BS}Zelys${BS}.claude${BS}projects${BS}C--Projects-x${BS}${UUID}.jsonl#turn3`,
      "docs/security/notes.md:7",
      "Users/Zelys/Projects/My-Very-Long-Project-Name/Docs/ApiKeys/NOTES.md:7",
      "C:/Users/zelys/AppData/Local/Temp/mem-import-kFxnGE/CLAUDE.md:1",
    ])("stores a word-shaped path pointer: %s", (sourceRef) => {
      expect(screenForSecrets({ text, sourceRef }, [])).toHaveLength(0);
    });
  });

  describe("an acronym or digit in a project directory name of a sourceRef pointer", () => {
    const text = "The AWS secret access key is noted in the source reference";

    it.each([
      "/Users/dev/OAuth2Client/src/AuthService.ts:42",
      "C:/Users/Zelys/GitHub/XMLParserTools/docs/notes.md:3",
      "/Users/dev/iOSAppProject/Docs/README.md:3",
      "/Users/dev/MyAPIClient/Docs/NOTES.md:3",
      "C:/Users/JSmithXYZ/Documents/Notes/MyAPINotes.md:12",
      "C:/Users/Zelys/.claude/projects/C--Projects-MyAPIClient/1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a.jsonl#turn3",
    ])("stores a path whose names are words and acronyms: %s", (sourceRef) => {
      expect(screenForSecrets({ text, sourceRef }, [])).toHaveLength(0);
    });

    it.each([
      `/Users/dev/${AWS_SECRET}:1`,
      "/Users/dev/bPxRfiCYEXAMPLEKEY/notes.md:3",
      "/Users/dev/zQvJxKtRmWnBcLdFg9H2pY/x7MqEnGpYhAsDw3Zc5Vb/Tn4RkLs8Xe/notes.md:3",
      "/Users/dev/FooBARBazQUXQuux/notes.md:3",
      "/Users/dev/AbXYZcDEFghIJKlm/notes.md:3",
    ])("still refuses a path with a secret-shaped name: %s", (sourceRef) => {
      expect(screenForSecrets({ text, sourceRef }, []).length).toBeGreaterThan(0);
    });
  });

  describe("a sourceRef the capture path stamped itself", () => {
    const text = "The AWS secret access key is noted in the source reference";
    const nameAndPointer = "1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a.jsonl#turn3";
    const missing = `/home/u/.claude/projects/-home-u-FooBARBazQUXQuux/${nameAndPointer}`;

    function realFile(directoryName: string, fileName: string): string {
      const directory = join(root, directoryName);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, fileName);
      writeFileSync(path, "x", "utf8");
      return path;
    }

    it("refuses the same ref when a caller typed it", () => {
      const stamped = `${realFile("-home-u-FooBARBazQUXQuux", "1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a.jsonl")}#turn3`;
      expect(screenFactFields({ text, sourceRef: stamped }, []).length).toBeGreaterThan(0);
    });

    it("skips only the entropy heuristic on a stamped ref to a file that exists", () => {
      const stamped = `${realFile("-home-u-FooBARBazQUXQuux", "1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a.jsonl")}#turn3`;
      expect(screenFactFields({ text, sourceRef: stamped, stampedSourceRef: true }, [])).toHaveLength(0);
    });

    it("skips the entropy heuristic on a stamped line pointer to a file that exists", () => {
      const stamped = `${realFile("-home-u-FooBARBazQUXQuux", "NOTES.md")}:3`;
      expect(screenFactFields({ text, sourceRef: stamped, stampedSourceRef: true }, [])).toHaveLength(0);
    });

    it("screens a flagged ref normally when its path does not exist", () => {
      expect(screenFactFields({ text, sourceRef: missing, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });

    it("screens a flagged ref normally when its path is a directory", () => {
      const directory = join(root, "-home-u-FooBARBazQUXQuux");
      mkdirSync(directory, { recursive: true });
      expect(screenFactFields({ text, sourceRef: `${directory}#turn3`, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });

    it("still refuses a stamped ref to a file in a secret-shaped directory, since the named patterns run on the path", () => {
      const stamped = `${realFile(`ghp_${"aB3dE9fG1hJ2kL3mN4pQ5rS6tU7vW8xY9zA0"}`, "NOTES.md")}:3`;
      expect(screenFactFields({ text, sourceRef: stamped, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });

    it.each([`${AWS_SECRET}:1`, `${AWS_SECRET}#turn3`, AWS_SECRET, `tok=${AWS_SECRET}:1`])("ignores the stamp on a ref without a stamped shape: %s", (sourceRef) => {
      expect(screenFactFields({ text, sourceRef, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });

    it("still runs the named patterns on a stamped ref", () => {
      const stamped = `${realFile("AKIAIOSFODNN7EXAMPLE", "FooBARBazQUXQuux.jsonl")}#turn3`;
      expect(screenFactFields({ text, sourceRef: stamped, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });

    it("still screens the fact text of a stamped capture", () => {
      const stamped = `${realFile("-home-u-FooBARBazQUXQuux", "1b4e28ba-2fa1-11d2-883f-b30c04fd1f2a.jsonl")}#turn3`;
      expect(screenFactFields({ text: `${text} AKIAIOSFODNN7EXAMPLE`, sourceRef: stamped, stampedSourceRef: true }, []).length).toBeGreaterThan(0);
    });
  });

  describe("a title abbreviation with a multi-word name after a hex sentence", () => {
    it.each([
      "Mr. John Smith's password",
      "Dr. Anna Lopez's api key",
      "Mrs. Jane Smith's password",
      "Ms. Mary Ann Jones's password",
      "MR. John Smith's password",
      "Mr. Password",
      "Mr. Api Key",
      "mr. Api Key",
      "Mrs. Smith Admin Password",
      "Dr. Smith's API Key",
      "Mr. J. Api Key",
      "Dr. J. Smith Api Key",
      "Prof. Smith Api Key",
      "Mrs. A. B. Smith Api Key",
      "Dr J. Smith Api Key",
      "Mr Smith Api Key",
      "Ms Smith Admin Password",
    ])("flags the hex before: %s", (label) => {
      expect(screenForSecrets({ text: `${HEX32}. ${label}.` }, []).length).toBeGreaterThan(0);
    });

    it.each([
      `Built ${HEX40}. Mr. John Smith's password reset email was fixed in the parser.`,
      `The md5 checksum ${HEX32}. Dr. Maria Lopez reviewed the password policy.`,
      `Built ${HEX40}. Mr. John Smith signed off the release.`,
      `Built ${HEX40}. Dr. Key reviewed the release notes.`,
      `Built ${HEX40}. Mr. Token Smith signed off the release.`,
      `Built ${HEX40}. Mrs. Password Jones joined the team.`,
      `Built ${HEX40}. Mr. J. Smith signed off the release.`,
      `Built ${HEX40}. Prof. Smith signed off the release.`,
      `Built ${HEX40}. Mr Smith signed off the release.`,
    ])("stores a hex followed by prose that merely names a person: %s", (text) => {
      expect(screenForSecrets({ text }, [])).toHaveLength(0);
    });
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

/** SECURITY.md documents where screening stops, using these three strings as its worked example. A documented boundary drifts as silently as any other doc claim -- and this one drifting in the permissive direction would be read by users as a guarantee the code no longer honours -- so the examples are asserted rather than left as prose. If a change here makes one of these fail, the fix is to update SECURITY.md in the same commit, not to delete the case. */
describe("the screening floor SECURITY.md documents", () => {
  const screen = (text: string): readonly unknown[] => screenForSecrets({ text }, []);

  it("refuses a credential word joined to its value by a separator", () => {
    expect(screen("password = Xk9mP2vL8nQ4wR").length).toBeGreaterThan(0);
  });

  it("refuses any standalone high-entropy token at or above the 32-character floor", () => {
    expect(screen("the staging password is Xk9mP2vL8nQ4wRq7Tz3Yb6Nc1Vd8Fg5Hj").length).toBeGreaterThan(0);
  });

  it("stores a short secret stated in prose, which is the documented limit", () => {
    // No separator, not hex, and 14 characters is under the entropy floor. Raising that floor is what would start refusing ordinary project facts, so this is an accepted position.
    expect(screen("the staging password is Xk9mP2vL8nQ4wR")).toHaveLength(0);
  });

  it("still stores a commit SHA quoted next to no credential word", () => {
    expect(screen("fixed in 5b743089c1e4f2a6b8d0c3e7f9a1b2c4d6e8f0a2")).toHaveLength(0);
  });
});
