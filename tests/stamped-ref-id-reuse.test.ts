/** End-to-end pins for the stamped-ref exemption across the flows that copy, restore, retire, prune or rewrite facts: the exemption belongs to the one fact whose own creation audit row recorded the stamped ref, so no other fact may gain it and a genuine stamped fact must not lose it. Observable: an edit that adds a labelled UUID to a fact whose source ref names a password is accepted only while the ref reads as a stamp. */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listAuditLogForFact } from "../src/db.js";
import { runCli, type CliResult } from "./support/cli.js";

/** Fake session UUID with entropy above the generic threshold, so only the labelled-identifier exemption decides each edit. */
const U = "3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
const DAY_MS = 86_400_000;

let base: string;
let home: string;
let transcriptCount = 0;

function useFreshHome(): string {
  home = mkdtempSync(join(base, "home-"));
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
  return home;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mem-stamped-ref-"));
  vi.stubEnv("TOKEN_GOAT_MEM_BACKUP_DIR", join(base, "backups"));
  useFreshHome();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

async function ok(args: readonly string[]): Promise<CliResult> {
  const result = await runCli(args);
  expect(result.exitCode, `mem ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result;
}

interface Seeded {
  readonly id: string;
  readonly ref: string;
}

async function shownRef(id: string): Promise<string> {
  const shown = JSON.parse((await ok(["show", id, "--json"])).stdout) as { fact: { source_ref: string } };
  return shown.fact.source_ref;
}

/** Files one pending suggestion through `mem scan-session` from a transcript under a directory named for a password, so the stamped ref is credential context unless the stamp binding exempts it. */
async function scanSentence(sentence: string, root = "."): Promise<void> {
  transcriptCount += 1;
  const directory = join(base, "admin password", `n${String(transcriptCount)}`);
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: sentence }] } }), "utf8");
  await ok(["scan-session", "--transcript", transcript, "--root", root]);
}

async function scanStamped(sentence: string, root = "."): Promise<Seeded> {
  await scanSentence(sentence, root);
  const id = UUID_PATTERN.exec((await ok(["list", "--status", "pending"])).stdout)?.[0] ?? "";
  expect(id, "scan-session filed no pending suggestion").not.toBe("");
  return { id, ref: await shownRef(id) };
}

async function promote(id: string, ...extra: string[]): Promise<void> {
  await ok(["review", "--promote", id, "--root", ".", ...extra]);
}

/** A user-typed fact whose source ref is the given text, e.g. one copied from a stamped fact. */
async function typed(text: string, ref: string, ...extra: string[]): Promise<string> {
  const stored = await ok(["remember", text, "--kind", "fact", "--scope", "project", "--root", ".", "--source-ref", ref, ...extra]);
  return /remembered (?:\S+ )?fact (\S+)/u.exec(stored.stdout)?.[1] ?? "";
}

/** Adds a labelled UUID to the fact: accepted only when its ref is not credential context, i.e. only while it reads as a stamp. */
async function addLabelledUuid(id: string): Promise<CliResult> {
  return runCli(["edit", id, "--force", "--text", `session id ${U}`, "--root", "."]);
}

async function expectExempt(id: string, why: string): Promise<void> {
  const result = await addLabelledUuid(id);
  expect(result.exitCode, `${why}: ${result.stderr}`).toBe(0);
}

async function expectRefusedAsSecret(id: string, why: string): Promise<void> {
  const result = await addLabelledUuid(id);
  expect(result.exitCode, `${why}: edit was accepted`).not.toBe(0);
  expect(result.stderr, why).toContain("secret");
}

function withStore<T>(path: string, body: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function storePath(): string {
  return join(home, "mem.db");
}

function snapshotPath(backupOutput: string): string {
  const path = /backed up to (.+?) \(epoch/u.exec(backupOutput)?.[1];
  expect(path, "backup printed no snapshot path").toBeDefined();
  return path ?? "";
}

describe("restore", () => {
  const SENTENCE = "Remember that the staging box notes live in the wiki.";

  it("keeps a stamped fact's exemption when its snapshot is restored into a fresh store", async () => {
    const stamped = await scanStamped(SENTENCE);
    const snapshot = snapshotPath((await ok(["backup"])).stdout);
    useFreshHome();
    await ok(["restore", snapshot]);
    expect(await shownRef(stamped.id), "the restored fact kept its ref").toBe(stamped.ref);
    await expectExempt(stamped.id, "restored stamped fact");
  });

  it("gives a typed twin of the stamped ref no exemption after restore, and honours a forged creation row copied onto it (accepted limit: forging needs store write access)", async () => {
    const stamped = await scanStamped(SENTENCE);
    const honest = await typed("typed twin without a forged row", stamped.ref);
    const forged = await typed("typed twin with a forged row", stamped.ref);
    withStore(storePath(), (db) => {
      const creation = db.prepare("SELECT event, detail FROM audit_log WHERE fact_id = ? AND event = 'capture_suggested'").get(stamped.id) as { event: string; detail: string };
      expect(creation.detail, "the stamped fact's creation row records its ref").toContain(`[stamped_ref=${stamped.ref}]`);
      db.prepare("INSERT INTO audit_log (id, event, fact_id, detail, prior_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)").run(randomUUID(), creation.event, forged, creation.detail, new Date().toISOString());
    });
    const snapshot = snapshotPath((await ok(["backup"])).stdout);
    useFreshHome();
    await ok(["restore", snapshot]);
    await expectExempt(stamped.id, "stamped original after restore");
    await expectRefusedAsSecret(honest, "typed twin whose id has no creation row");
    await expectExempt(forged, "restore carries the audit table verbatim, so a forged row is honoured (accepted limit)");
  });
});

describe("mem consolidate --apply", () => {
  it("never lets a typed duplicate gain the stamped fact's exemption, whichever of the cluster survives", async () => {
    const stamped = await scanStamped("Remember that the staging box notes live in the wiki.");
    await promote(stamped.id);
    const duplicate = await typed("the staging box notes live in the wiki", stamped.ref);
    const report = (await ok(["consolidate", "--apply"])).stdout;
    expect(report, "the pair was clustered as duplicates and one was superseded").toMatch(/supersed/u);
    const statuses: (string | undefined)[] = [];
    for (const id of [stamped.id, duplicate]) {
      statuses.push(/status: (\w+)/u.exec((await ok(["show", id])).stdout)?.[1]);
    }
    expect(statuses.filter((status) => status === "superseded"), `exactly one loser: ${statuses.join(",")}`).toHaveLength(1);
    await expectRefusedAsSecret(duplicate, "typed duplicate after consolidate");
    await expectExempt(stamped.id, "stamped fact after consolidate, survivor or loser");
  });
});

describe("contradiction supersede, forget --by and restatement", () => {
  const SUBJECT = ["--subject", "staging host"] as const;

  it("keeps the binding on a stamped loser and grants none to the typed winner after a contradiction supersede", async () => {
    const stamped = await scanStamped("Remember that the staging host is blue.");
    await promote(stamped.id, ...SUBJECT, "--value", "blue");
    const winner = await typed("the staging host is red", stamped.ref, ...SUBJECT, "--value", "red");
    await ok(["epoch", "--gc"]);
    expect((await ok(["show", stamped.id])).stdout, "the stamped fact lost the contradiction").toContain("status: superseded");
    expect((await ok(["show", winner])).stdout).toContain("status: active");
    await expectRefusedAsSecret(winner, "typed winner of the supersede");
    await expectExempt(stamped.id, "stamped loser of the supersede");
  });

  it("keeps the binding on a stamped winner of forget --by and grants none to the typed loser", async () => {
    const stamped = await scanStamped("Remember that the staging host is blue.");
    await promote(stamped.id);
    const loser = await typed("the staging host is red", stamped.ref);
    await ok(["forget", loser, "--by", stamped.id]);
    await expectRefusedAsSecret(loser, "typed loser retired by the stamped fact");
    await expectExempt(stamped.id, "stamped winner of forget --by");
  });

  it("drops the exemption when an explicit restatement overwrites a promoted stamped fact's ref with a typed one", async () => {
    const sentence = "Remember that the staging box notes live in the wiki.";
    const stamped = await scanStamped(sentence);
    await promote(stamped.id);
    await ok(["remember", sentence, "--kind", "fact", "--scope", "project", "--root", ".", "--source-ref", "/admin password#turn3"]);
    expect(await shownRef(stamped.id), "the restatement overwrote the stamped ref").toBe("/admin password#turn3");
    await expectRefusedAsSecret(stamped.id, "stamped fact whose ref was overwritten by a typed restatement");
  });

  it("does not stamp an active typed fact when a scan-session sighting restates it", async () => {
    const sentence = "Remember that the staging box notes live in the wiki.";
    const id = await typed(sentence, "/admin password#turn3");
    await scanSentence(sentence);
    expect((await ok(["list", "--status", "pending"])).stdout, "the sentence is already live, so the scan filed nothing").not.toMatch(UUID_PATTERN);
    expect(await shownRef(id), "the sighting left the typed ref alone").toBe("/admin password#turn3");
    await expectRefusedAsSecret(id, "typed fact restated by a scan-session sighting");
  });
});

describe("forget, gc and a new capture with the old stamped ref", () => {
  const SENTENCE = "Remember that the staging box notes live in the wiki.";

  /** Forgets the fact, then back-dates its status change past the 90-day window and (optionally) every audit row past the 180-day window, so `mem epoch --gc` prunes it. */
  async function forgetAndAge(id: string, ageAudit: boolean): Promise<void> {
    await ok(["forget", id]);
    withStore(storePath(), (db) => {
      db.prepare("UPDATE facts SET status_changed_at = ? WHERE id = ?").run(new Date(Date.now() - 100 * DAY_MS).toISOString(), id);
      if (ageAudit) {
        db.prepare("UPDATE audit_log SET created_at = ? WHERE fact_id = ?").run(new Date(Date.now() - 200 * DAY_MS).toISOString(), id);
      }
    });
    const pruned = (await ok(["epoch", "--gc"])).stdout;
    expect(pruned, "gc hard-deleted the forgotten fact").toContain("pruned_superseded_facts=1");
    expect((await runCli(["show", id])).exitCode, "the pruned fact is gone").not.toBe(0);
  }

  function auditRowsFor(id: string): number {
    return withStore(storePath(), (db) => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE fact_id = ?").get(id) as { n: number }).n);
  }

  function craftedExport(id: string, ref: string): string {
    const path = join(base, `crafted-${randomUUID()}.json`);
    const fact = {
      id,
      text: "an unrelated note that merely reuses the id",
      kind: "fact",
      subject: null,
      value: null,
      scope: "project",
      scopeRoot: process.cwd(),
      source_type: "user",
      source_ref: ref,
      why: null,
      captured_at: new Date().toISOString(),
      anchor: null,
      status: "active",
      confidence: 1,
      embedding: null,
    };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), embeddingMeta: null, facts: [fact] }), "utf8");
    return path;
  }

  it("gives a new capture that types the pruned stamp's ref no exemption, and never reuses the pruned id", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    await forgetAndAge(stamped.id, false);
    expect(auditRowsFor(stamped.id), "the creation audit row outlives the fact (180-day window)").toBeGreaterThan(0);
    const fresh = await typed("a new note after the gc", stamped.ref);
    expect(fresh, "a capture mints a new id").not.toBe(stamped.id);
    await expectRefusedAsSecret(fresh, "new capture typing the pruned stamp's ref");
  });

  // importFromJson preserves a caller-supplied id, so the pruned stamped fact's surviving capture_suggested row would bind to an unrelated imported fact that reuses its id and ref; the later json_import row voids that binding.
  it("gives a crafted JSON import that reuses the pruned id and ref no exemption (fact ids are caller-supplied only on --from-json)", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    await forgetAndAge(stamped.id, false);
    await ok(["import", "--from-json", craftedExport(stamped.id, stamped.ref), "--root", "."]);
    expect((await ok(["show", stamped.id])).stdout, "the import recreated the id with the unrelated text").toContain("an unrelated note");
    await expectRefusedAsSecret(stamped.id, "unrelated imported fact that reuses the pruned id");
  });

  it("fails closed for a crafted JSON import of the pruned id once gc also pruned the audit rows", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    await forgetAndAge(stamped.id, true);
    await ok(["epoch", "--gc"]);
    expect(auditRowsFor(stamped.id), "gc pruned the creation row").toBe(0);
    await ok(["import", "--from-json", craftedExport(stamped.id, stamped.ref), "--root", "."]);
    await expectRefusedAsSecret(stamped.id, "imported id with no surviving creation row");
  });

  it("fails closed for a stamped fact that gc's audit pruning orphaned (accepted limit)", async () => {
    const stamped = await scanStamped(SENTENCE);
    withStore(storePath(), (db) => db.prepare("UPDATE audit_log SET created_at = ? WHERE fact_id = ?").run(new Date(Date.now() - 200 * DAY_MS).toISOString(), stamped.id));
    await ok(["epoch", "--gc"]);
    expect(auditRowsFor(stamped.id), "gc pruned the stamped fact's creation row").toBe(0);
    await expectRefusedAsSecret(stamped.id, "genuine stamp whose creation row gc pruned");
  });

  it("refuses a JSON export and re-import of a stamped fact into a fresh store, because the import writes its own provenance row", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    const exported = join(base, "export.json");
    writeFileSync(exported, (await ok(["export"])).stdout, "utf8");
    expect(readFileSync(exported, "utf8"), "the export carries the stamped ref").toContain("admin password");
    useFreshHome();
    await ok(["import", "--from-json", exported, "--root", "."]);
    await expectRefusedAsSecret(stamped.id, "pinned observed behaviour: a JSON re-import is a new capture and fails closed");
  });
});

describe("mem edit --undo", () => {
  const SENTENCE = "Remember that the staging box notes live in the wiki.";

  it("undoes a labelled-UUID edit on a stamped fact, and undoes the edit after it back to the labelled UUID", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    await ok(["edit", stamped.id, "--force", "--text", `session id ${U}`, "--root", "."]);
    await ok(["edit", stamped.id, "--undo", "--root", "."]);
    expect((await ok(["show", stamped.id])).stdout, "the undo restored the scanned text").toContain(`text: ${SENTENCE}`);
    await ok(["edit", stamped.id, "--force", "--text", `session id ${U}`, "--root", "."]);
    await ok(["edit", stamped.id, "--force", "--text", "plain note", "--root", "."]);
    const undone = await runCli(["edit", stamped.id, "--undo", "--root", "."]);
    expect(undone.exitCode, `the undo re-screens the restored labelled UUID against the stamped ref: ${undone.stderr}`).toBe(0);
    expect((await ok(["show", stamped.id])).stdout).toContain(`text: session id ${U}`);
  });

  it("refuses an undo that restores a labelled UUID once the stamp binding is gone", async () => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    await ok(["edit", stamped.id, "--force", "--text", `session id ${U}`, "--root", "."]);
    await ok(["edit", stamped.id, "--force", "--text", "plain note", "--root", "."]);
    withStore(storePath(), (db) => db.prepare("DELETE FROM audit_log WHERE fact_id = ? AND event = 'capture_suggested'").run(stamped.id));
    const undone = await runCli(["edit", stamped.id, "--undo", "--root", "."]);
    expect(undone.exitCode, "the undo restored a state the screen refuses on a fresh write").not.toBe(0);
    expect(undone.stderr).toContain("secret");
    expect((await ok(["show", stamped.id])).stdout, "the refused undo left the text alone").toContain("text: plain note");
  });

  it.each(["api key", "password", "secret token"])("refuses a %s label beside the UUID even on a stamped fact", async (label) => {
    const stamped = await scanStamped(SENTENCE);
    await promote(stamped.id);
    const edited = await runCli(["edit", stamped.id, "--force", "--text", `${label} ${U}`, "--root", "."]);
    expect(edited.exitCode, "a credential keyword beside the UUID must be refused").not.toBe(0);
    expect(edited.stderr).toContain("secret");
    expect((await ok(["show", stamped.id])).stdout, "the refused edit left the text alone").toContain(`text: ${SENTENCE}`);
  });
});

describe("audit log read order at an exact created_at tie", () => {
  const TIED_AT = "2030-01-01T00:00:00.000Z";

  function insertAudit(db: Database.Database, id: string, event: string, detail: string): void {
    db.prepare("INSERT INTO audit_log (id, event, fact_id, detail, prior_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)").run(randomUUID(), event, id, detail, TIED_AT);
  }

  it("reads rows that share one created_at back in insertion (rowid) order", async () => {
    const stamped = await scanStamped("Remember that the staging box notes live in the wiki.");
    const events = withStore(storePath(), (db) => {
      for (const event of ["tie_a", "tie_b", "tie_c"]) {
        insertAudit(db, stamped.id, event, event);
      }
      return listAuditLogForFact(db, stamped.id).filter((row) => row.createdAt === TIED_AT).map((row) => row.event);
    });
    expect(events, "tied rows come back oldest first, broken by rowid").toEqual(["tie_a", "tie_b", "tie_c"]);
  });

  it("withholds the exemption when a json_import row ties with the creation row but was written after it", async () => {
    const stamped = await scanStamped("Remember that the staging box notes live in the wiki.");
    await promote(stamped.id);
    withStore(storePath(), (db) => {
      db.prepare("UPDATE audit_log SET created_at = ? WHERE fact_id = ? AND event = 'capture_suggested'").run(TIED_AT, stamped.id);
      insertAudit(db, stamped.id, "json_import", "imported");
    });
    await expectRefusedAsSecret(stamped.id, "a json_import row written after the creation row at the same millisecond voids the binding");
  });

  it("keeps the exemption when the json_import row ties with the creation row but was written before it", async () => {
    const stamped = await scanStamped("Remember that the staging box notes live in the wiki.");
    await promote(stamped.id);
    withStore(storePath(), (db) => {
      const creation = db.prepare("SELECT detail FROM audit_log WHERE fact_id = ? AND event = 'capture_suggested'").get(stamped.id) as { detail: string };
      db.prepare("DELETE FROM audit_log WHERE fact_id = ? AND event = 'capture_suggested'").run(stamped.id);
      insertAudit(db, stamped.id, "json_import", "imported");
      insertAudit(db, stamped.id, "capture_suggested", creation.detail);
    });
    await expectExempt(stamped.id, "a creation row written after a json_import row at the same millisecond rebinds the stamp");
  });
});

describe("the .mem/allowlist remedy unblocks each fail-closed stamped-ref refusal", () => {
  const SENTENCE = "Remember that the staging box notes live in the wiki.";
  const EDITED_TEXT = `session id ${U}`;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(base, "root-"));
  });

  async function editAt(id: string): Promise<CliResult> {
    return runCli(["edit", id, "--force", "--text", EDITED_TEXT, "--root", root]);
  }

  /** The refusal names the remedy, then the remedy works: the same edit is refused, the UUID goes into `<root>/.mem/allowlist`, and the same edit is accepted and stored. */
  async function expectAllowlistUnblocks(id: string, why: string): Promise<void> {
    const refused = await editAt(id);
    expect(refused.exitCode, `${why}: the edit must be refused before the allowlist entry`).not.toBe(0);
    expect(refused.stderr, `${why}: the refusal names the remedy`).toContain(".mem/allowlist");
    mkdirSync(join(root, ".mem"), { recursive: true });
    writeFileSync(join(root, ".mem", "allowlist"), `# reviewed fake session id\n${U}\n`, "utf8");
    const accepted = await editAt(id);
    expect(accepted.exitCode, `${why}: the same edit after the allowlist entry: ${accepted.stderr}`).toBe(0);
    expect((await ok(["show", id])).stdout, `${why}: the stored fact shows the edit`).toContain(`text: ${EDITED_TEXT}`);
  }

  it("unblocks the edit of a stamped fact rebuilt by a JSON export and re-import into a fresh store", async () => {
    const stamped = await scanStamped(SENTENCE, root);
    await ok(["review", "--promote", stamped.id, "--root", root]);
    const exported = join(base, "export.json");
    writeFileSync(exported, (await ok(["export"])).stdout, "utf8");
    useFreshHome();
    await ok(["import", "--from-json", exported, "--root", root]);
    expect(await shownRef(stamped.id), "the re-imported fact kept the stamped ref").toBe(stamped.ref);
    await expectAllowlistUnblocks(stamped.id, "JSON re-import");
  });

  it("unblocks the edit of a stamped fact whose creation audit row gc pruned", async () => {
    const stamped = await scanStamped(SENTENCE, root);
    withStore(storePath(), (db) => db.prepare("UPDATE audit_log SET created_at = ? WHERE fact_id = ?").run(new Date(Date.now() - 200 * DAY_MS).toISOString(), stamped.id));
    await ok(["epoch", "--gc"]);
    const remaining = withStore(storePath(), (db) => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE fact_id = ?").get(stamped.id) as { n: number }).n);
    expect(remaining, "gc pruned the stamped fact's creation row").toBe(0);
    await expectAllowlistUnblocks(stamped.id, "gc-pruned creation row");
  });

  it("unblocks the edit of a stamped fact whose creation row predates the stamped_ref marker", async () => {
    const stamped = await scanStamped(SENTENCE, root);
    const stripped = withStore(storePath(), (db) => {
      const row = db.prepare("SELECT id, detail FROM audit_log WHERE fact_id = ? AND event = 'capture_suggested'").get(stamped.id) as { id: string; detail: string };
      expect(row.detail, "the creation row carries the marker before it is stripped").toContain("[stamped_ref=");
      const detail = row.detail.replace(/ \[stamped_ref=[^\]]*\]/u, "");
      db.prepare("UPDATE audit_log SET detail = ? WHERE id = ?").run(detail, row.id);
      return detail;
    });
    expect(stripped, "the marker is gone from the creation row").not.toContain("[stamped_ref=");
    await expectAllowlistUnblocks(stamped.id, "pre-marker creation row");
  });
});
