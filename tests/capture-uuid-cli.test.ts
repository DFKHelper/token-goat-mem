/** End-to-end pins for the bare-UUID exemption in the secret screen: a high-entropy UUID is exempt only when an identifier word labels it, and the credential-keyword veto reads the whole fact as it will be stored (edit, promote, scan-session, import) and never exempts anchors or source refs. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRememberedId, extractSuggestedId, runCli } from "./support/cli.js";

/** Entropy above the 3.8 generic threshold, so the exemption is what decides each case. */
const U = "3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-uuid-cli-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function remember(text: string, ...extra: string[]): Promise<string> {
  const result = await runCli(["remember", text, "--kind", "fact", "--scope", "global", ...extra]);
  expect(result.exitCode, result.stderr).toBe(0);
  return extractRememberedId(result);
}

async function suggest(text: string): Promise<string> {
  const result = await runCli(["suggest", text, "--kind", "fact", "--scope", "global"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return extractSuggestedId(result);
}

function expectRefused(result: { readonly exitCode: number | undefined; readonly stderr: string }): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("secret");
}

function writeTranscript(turn: string): string {
  const transcript = join(home, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: turn }] } }), "utf8");
  return transcript;
}

describe("mem edit reads the merged post-edit fact for credential keywords", () => {
  it("refuses a labelled UUID in --value when the stored text names a password (E1)", async () => {
    const id = await remember("Staging db password is rotated weekly");
    expectRefused(await runCli(["edit", id, "--force", "--subject", "staging db", "--value", `session id ${U}`]));
  });

  it("refuses a labelled UUID in --text when the stored subject names a password (E2)", async () => {
    const id = await remember("Staging notes", "--subject", "staging password", "--value", "rotated");
    expectRefused(await runCli(["edit", id, "--force", "--text", `The session id is ${U} for the staging box`]));
  });

  it("refuses a labelled UUID in --why when the stored text names a password (E3)", async () => {
    const id = await remember("Staging db password is rotated weekly");
    expectRefused(await runCli(["edit", id, "--force", "--why", `the session id is ${U}`]));
  });

  it("allows the same labelled UUID on a fact with no credential keyword anywhere", async () => {
    const id = await remember("Staging box notes");
    const result = await runCli(["edit", id, "--force", "--why", `the session id is ${U}`]);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("mem review --promote reads the merged fact for credential keywords", () => {
  it("refuses a labelled UUID in --value when the pending fact names a password (P1)", async () => {
    const id = await suggest("Staging db password is rotated weekly");
    expectRefused(await runCli(["review", "--promote", id, "--subject", "x", "--value", `session id ${U}`]));
  });

  it("refuses a labelled UUID in --reason when the pending fact names a password (P2)", async () => {
    const id = await suggest("Staging db password is rotated weekly");
    expectRefused(await runCli(["review", "--promote", id, "--reason", `the session id is ${U}`]));
  });

  it("promotes with a labelled UUID reason when nothing names a credential", async () => {
    const id = await suggest("Staging box notes");
    const result = await runCli(["review", "--promote", id, "--reason", `the session id is ${U}`]);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("mem scan-session reads the whole user turn for credential keywords", () => {
  async function pendingListing(): Promise<string> {
    return (await runCli(["list", "--status", "pending"])).stdout;
  }

  it("files no suggestion holding the UUID when the turn names a password (S1b)", async () => {
    const transcript = writeTranscript(`Here is the prod db password. Remember that it is ${U} for the session job.`);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(await pendingListing()).not.toContain(U);
  });

  it("files no suggestion holding a labelled UUID when a previous line of the turn names a password (S1)", async () => {
    const transcript = writeTranscript(`Here is the prod db password.\nRemember that the session id is ${U}.`);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(await pendingListing()).not.toContain(U);
  });

  it("files a labelled UUID from a turn with no credential keyword (S3)", async () => {
    const transcript = writeTranscript(`Remember that the session id is ${U}.`);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(await pendingListing()).toContain(U);
  });
});

describe("mem import --from-md reads the section and file name for credential keywords", () => {
  async function importFile(name: string, lines: readonly string[]): Promise<string> {
    const path = join(home, name);
    writeFileSync(path, lines.join("\n"), "utf8");
    await runCli(["import", "--from-md", path, "--root", home]);
    return (await runCli(["list", "--status", "pending"])).stdout;
  }

  it("skips a bullet under a password heading (I1)", async () => {
    expect(await importFile("notes.md", ["## Prod DB password", "", `- the session job uses ${U}`])).not.toContain(U);
  });

  it("skips a labelled bullet whose section names a password in another bullet (I2)", async () => {
    expect(await importFile("notes.md", ["## Prod", "", "- the prod db password is rotated weekly", `- the session id is ${U}`])).not.toContain(U);
  });

  it("skips a labelled bullet in a file named for passwords (I3)", async () => {
    expect(await importFile("passwords.md", ["## Prod", "", `- the session id is ${U}`])).not.toContain(U);
  });

  it("skips a labelled bullet nested under a password heading of a shallower level", async () => {
    expect(await importFile("notes.md", ["# Prod DB password", "", "## Ids", "", `- the session id is ${U}`])).not.toContain(U);
  });

  it("files a labelled bullet under an ids heading", async () => {
    expect(await importFile("notes.md", ["## Session ids", "", `- the session id is ${U}`])).toContain(U);
  });
});

describe("anchors and source refs get no identifier-word exemption", () => {
  it("refuses a UUID in a free-text anchor (N7a)", async () => {
    expectRefused(await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--anchor", `file-contains session_token_id.txt ${U}`]));
  });

  it("refuses a labelled UUID in a free-text source ref (N7b)", async () => {
    expectRefused(await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--source-ref", `api key for session ${U}`]));
  });

  it("refuses a UUID in a source ref that names a password (N7c)", async () => {
    expectRefused(await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--source-ref", `password for session ${U}`]));
  });

  it("refuses a bare labelled UUID in a source ref", async () => {
    expectRefused(await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--source-ref", `session id ${U}`]));
  });

  it.each([
    ["a POSIX transcript path", `/home/user/.claude/projects/proj/${U}.jsonl#turn3`],
    ["a Windows transcript path", `C:/Users/user/.claude/projects/proj/${U}.jsonl#turn3`.replaceAll("/", String.fromCharCode(92))],
  ])("still stores %s as a source ref", async (_label, sourceRef) => {
    const result = await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--source-ref", sourceRef]);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("credential keywords the veto learned", () => {
  const ZWSP = String.fromCharCode(0x200b);
  const SHY = String.fromCharCode(0xad);
  const NTILDE = String.fromCharCode(0xf1);

  it.each([
    ["passcode", "the passcode rotates"],
    ["TOTP", "TOTP is enabled"],
    ["MFA", "MFA is enabled"],
    ["HMAC", "the HMAC is checked"],
    ["JWT", "the JWT expires"],
    ["salt", "the salt is fixed"],
    ["nonce", "the nonce is reused"],
    ["Passwort", "das Passwort ist neu"],
    ["contrasena with a tilde", `la contrase${NTILDE}a es nueva`],
    ["a zero-width space inside the word", `pass${ZWSP}word rotation`],
    ["a soft hyphen inside the word", `pass${SHY}word rotation`],
  ])("refuses a labelled UUID when the text carries %s", async (_label, other) => {
    expectRefused(await runCli(["remember", `session id ${U}; ${other}`, "--kind", "fact", "--scope", "global"]));
  });
});

describe("a low-entropy UUID is refused beside a credential keyword whatever its entropy", () => {
  const LOW = "11111111-1111-1111-1111-111111111111";

  it("refuses a low-entropy UUID beside api key", async () => {
    expectRefused(await runCli(["remember", `api key ${LOW}`, "--kind", "fact", "--scope", "global"]));
  });

  it("refuses a low-entropy labelled UUID when the subject names a token", async () => {
    expectRefused(await runCli(["remember", `session id ${LOW}`, "--kind", "fact", "--scope", "global", "--subject", "auth token", "--value", "rotated"]));
  });

  it("stores a bare low-entropy UUID with no credential keyword", async () => {
    const result = await runCli(["remember", `the build id is ${LOW}`, "--kind", "fact", "--scope", "global"]);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("a UUID that an identifier word labels still stores", () => {
  it.each([
    ["the session id is U", `the session id is ${U}`],
    ["request id: U", `request id: ${U}`],
    ["trace U failed", `trace ${U} failed`],
    ["fact U passed review", `fact ${U} passed review`],
  ])("%s", async (_label, text) => {
    await remember(text);
  });

  it("stores a labelled UUID alongside a subject and value", async () => {
    await remember(`run ${U} finished`, "--subject", "ci", "--value", "green");
  });

  it("refuses an identifier word that is nearby but does not label the UUID", async () => {
    expectRefused(await runCli(["remember", `the session job is done; ${U}`, "--kind", "fact", "--scope", "global"]));
  });
});

describe("a credential word added after capture vetoes a stored labelled UUID", () => {
  it("refuses an edit whose --why adds a password to a stored labelled UUID (B1)", async () => {
    const id = await remember(`session id ${U}`);
    expectRefused(await runCli(["edit", id, "--force", "--why", "this is the admin password"]));
  });

  it("refuses an edit whose --subject alone adds a credential word, with no UUID in the patch", async () => {
    const id = await remember(`session id ${U}`);
    expectRefused(await runCli(["edit", id, "--force", "--subject", "admin password", "--value", "rotated"]));
  });

  it("refuses a promotion whose --reason adds a password to a pending labelled UUID", async () => {
    const id = await suggest(`build id ${U}`);
    expectRefused(await runCli(["review", "--promote", id, "--reason", "the admin password"]));
  });

  it("leaves a refused edit unapplied", async () => {
    const id = await remember(`session id ${U}`);
    await runCli(["edit", id, "--force", "--why", "this is the admin password"]);
    expect((await runCli(["show", id])).stdout).not.toContain("admin password");
  });
});

describe("a review reason is screened with the fact it is recorded on", () => {
  it("refuses a --reject reason holding a labelled UUID when the fact names a credential", async () => {
    const id = await suggest("the db password hint is in vault");
    expectRefused(await runCli(["review", "--reject", id, "--reason", `session id ${U}`]));
  });

  it("refuses an --undo reason holding a labelled UUID when the fact names a credential", async () => {
    const id = await suggest("the db password hint is in vault");
    const rejected = await runCli(["review", "--reject", id, "--reason", "stale"]);
    expect(rejected.exitCode, rejected.stderr).toBe(0);
    expectRefused(await runCli(["review", "--undo", id, "--reason", `session id ${U}`]));
  });

  it("records a labelled UUID reason when the fact names no credential", async () => {
    const id = await suggest("Staging box notes");
    const result = await runCli(["review", "--reject", id, "--reason", `session id ${U}`]);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("credential keywords added to the veto", () => {
  it.each([
    ["mot de passe", "le mot de passe est nouveau"],
    ["mot de passe across a line break", `le mot${String.fromCharCode(10)}de passe est nouveau`],
    ["clave", "la clave es nueva"],
    ["senha", "a senha e nova"],
    ["kennwort", "das Kennwort ist neu"],
    ["geheim", "das ist geheim"],
    ["mdp", "le mdp est nouveau"],
    ["psk", "the psk is new"],
    ["seed phrase", "the seed phrase is stored"],
    ["mnemonic", "the mnemonic is stored"],
    ["vault", "the vault is sealed"],
    ["sekret", "sekret is stored"],
    ["secret", "the secret is stored"],
    ["reset", "the reset is pending"],
    ["invite", "the invite is pending"],
    ["pairing", "the pairing is pending"],
    ["ssh", "the ssh login is set"],
  ])("refuses a labelled UUID when the text carries %s", async (_label, other) => {
    expectRefused(await runCli(["remember", `session id ${U}; ${other}`, "--kind", "fact", "--scope", "global"]));
  });

  it.each(["reset", "invite", "pairing", "seed", "vault", "ssh", "wifi psk"])("refuses the identifier label %s id", async (label) => {
    expectRefused(await runCli(["remember", `${label} id ${U}`, "--kind", "fact", "--scope", "global"]));
  });
});

describe("the anchor, a typed source ref, and the import directory are credential context", () => {
  it("refuses a labelled UUID when the anchor arguments name a password", async () => {
    expectRefused(await runCli(["remember", `session id ${U}`, "--kind", "fact", "--scope", "global", "--anchor", "file-contains password.txt x"]));
  });

  it("refuses a labelled UUID when a typed source ref names a password", async () => {
    expectRefused(await runCli(["remember", `session id ${U}`, "--kind", "fact", "--scope", "global", "--source-ref", "password notes"]));
  });

  it("skips a labelled bullet in a file under a directory named for secrets", async () => {
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "g.md"), ["## Prod", "", `- the session id is ${U}`].join("\n"), "utf8");
    await runCli(["import", "--from-md", join(home, "secrets", "g.md"), "--root", home]);
    expect((await runCli(["list", "--status", "pending"])).stdout).not.toContain(U);
  });
});

describe("a stored source ref is credential context on edit and promote", () => {
  it("refuses an edit that adds a labelled UUID to a fact whose typed source ref names a password", async () => {
    const id = await remember("note about ids", "--source-ref", "admin password");
    expectRefused(await runCli(["edit", id, "--force", "--text", `session id ${U}`]));
    expect((await runCli(["show", id])).stdout).toContain("text: note about ids");
  });

  it("refuses to edit and then promote a suggestion whose typed source ref names a password", async () => {
    const created = await runCli(["suggest", "note about ids", "--kind", "fact", "--scope", "global", "--source-ref", "admin password"]);
    expect(created.exitCode, created.stderr).toBe(0);
    const id = extractSuggestedId(created);
    expectRefused(await runCli(["edit", id, "--text", `session id ${U}`]));
    expect((await runCli(["show", id])).stdout).toContain("text: note about ids");
    expectRefused(await runCli(["review", "--promote", id, "--subject", "session id", "--value", U]));
    expect((await runCli(["show", id])).stdout).toContain("status: pending");
  });

  it("still edits a scan-session fact to add a labelled UUID despite its stamped transcript path", async () => {
    const transcript = writeTranscript("Remember that the staging box is blue.");
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const listing = (await runCli(["list", "--status", "pending"])).stdout;
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(listing)?.[0] ?? "";
    expect(id).not.toBe("");
    const edited = await runCli(["edit", id, "--text", `session id ${U}`]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(`text: session id ${U}`);
  });

  it.each(["C:/x/admin password#turn3", "/admin password#turn3"])("refuses an edit when a typed source ref only has the shape of the scan-session stamp: %s", async (ref) => {
    const id = await remember("note about ids", "--source-ref", ref);
    expectRefused(await runCli(["edit", id, "--force", "--text", `session id ${U}`]));
    expect((await runCli(["show", id])).stdout).toContain("text: note about ids");
  });

  it("refuses to edit and then promote a suggestion whose typed source ref forges the stamp", async () => {
    const created = await runCli(["suggest", "note about ids", "--kind", "fact", "--scope", "global", "--source-ref", "/admin password#turn3"]);
    expect(created.exitCode, created.stderr).toBe(0);
    const id = extractSuggestedId(created);
    expectRefused(await runCli(["edit", id, "--text", `session id ${U}`]));
    expect((await runCli(["show", id])).stdout).toContain("text: note about ids");
    expectRefused(await runCli(["review", "--promote", id, "--subject", "session id", "--value", U]));
    expect((await runCli(["show", id])).stdout).toContain("status: pending");
  });

  it("still edits a scan-session fact whose transcript directory names a password, because the creation audit row proves the stamp", async () => {
    const directory = join(home, "admin password");
    mkdirSync(directory);
    const transcript = join(directory, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Remember that the staging box is blue." }] } }), "utf8");
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const listing = (await runCli(["list", "--status", "pending"])).stdout;
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(listing)?.[0] ?? "";
    expect(id).not.toBe("");
    const edited = await runCli(["edit", id, "--text", `session id ${U}`]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(`text: session id ${U}`);
  });
});

describe("the scan-session stamp exemption is bound to the capture that wrote it", () => {
  const SENTENCE = "Remember that the staging box notes live in the wiki.";
  const EDITED = `The session id is ${U} for the staging box`;
  const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

  async function scanSession(): Promise<void> {
    const result = await runCli(["scan-session", "--transcript", writeTranscript(SENTENCE), "--scope", "project", "--root", "."]);
    expect(result.exitCode, result.stderr).toBe(0);
  }

  async function onlyPendingId(): Promise<string> {
    const id = UUID_PATTERN.exec((await runCli(["list", "--status", "pending"])).stdout)?.[0] ?? "";
    expect(id).not.toBe("");
    return id;
  }

  async function suggestForged(ref: string): Promise<string> {
    const created = await runCli(["suggest", SENTENCE, "--kind", "fact", "--scope", "project", "--root", ".", "--source-ref", ref]);
    expect(created.exitCode, created.stderr).toBe(0);
    return extractSuggestedId(created);
  }

  it.each(["/admin password#turn3", "C:/x/admin password#turn3"])("refuses an edit after a restatement overwrote the stamped ref with a typed one: %s", async (ref) => {
    await scanSession();
    const id = await onlyPendingId();
    const restated = await runCli(["remember", SENTENCE, "--kind", "fact", "--scope", "project", "--root", ".", "--source-ref", ref]);
    expect(restated.exitCode, restated.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(ref);
    expectRefused(await runCli(["edit", id, "--force", "--text", EDITED, "--root", "."]));
    expect((await runCli(["show", id])).stdout).toContain(`text: ${SENTENCE}`);
  });

  it.each(["/admin password#turn3", "C:/x/admin password#turn3"])("refuses an edit after a scan-session sighting joined a suggestion with a typed ref: %s", async (ref) => {
    const id = await suggestForged(ref);
    await scanSession();
    expectRefused(await runCli(["edit", id, "--force", "--text", EDITED, "--root", "."]));
    expect((await runCli(["show", id])).stdout).toContain(`text: ${SENTENCE}`);
  });

  it("refuses to promote a suggestion with a typed ref after a scan-session sighting, leaving it pending", async () => {
    const id = await suggestForged("/admin password#turn3");
    await scanSession();
    expectRefused(await runCli(["review", "--promote", id, "--subject", "staging session", "--value", `session id ${U}`, "--root", "."]));
    expect((await runCli(["show", id])).stdout).toContain("status: pending");
  });

  it("refuses an edit after a markdown import sighting joined a suggestion with a typed ref", async () => {
    const id = await suggestForged("/admin password#turn3");
    const notes = join(home, "notes.md");
    writeFileSync(notes, `- ${SENTENCE}\n`, "utf8");
    const imported = await runCli(["import", "--from-md", notes, "--root", "."]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expectRefused(await runCli(["edit", id, "--force", "--text", EDITED, "--root", "."]));
    expect((await runCli(["show", id])).stdout).toContain(`text: ${SENTENCE}`);
  });

  it("still edits a scan-session fact to add a labelled UUID, then undoes the edit", async () => {
    await scanSession();
    const id = await onlyPendingId();
    const edited = await runCli(["edit", id, "--force", "--text", EDITED, "--root", "."]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    const undone = await runCli(["edit", id, "--undo", "--root", "."]);
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(`text: ${SENTENCE}`);
  });

  it("still reads a scan-session fact's stamp when a --reject reason carries a labelled UUID", async () => {
    await scanSession();
    const id = await onlyPendingId();
    const rejected = await runCli(["review", "--reject", id, "--reason", `session id ${U}`, "--root", "."]);
    expect(rejected.exitCode, rejected.stderr).toBe(0);
  });
});

describe("an imported fact's file path is not credential context on edit", () => {
  const BULLET = "- the staging box notes live in the wiki";
  const EDITED = `the session id is ${U} for the staging box`;

  async function importedId(relativePath: string): Promise<string> {
    const path = join(home, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, ["## Prod", "", BULLET].join("\n"), "utf8");
    const imported = await runCli(["import", "--from-md", path, "--root", home]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    const listed = (await runCli(["list", "--status", "pending"])).stdout;
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(listed)?.[0] ?? "";
    expect(id).not.toBe("");
    return id;
  }

  it.each([
    ["a directory named for a token", "token-goat-mem/notes.md"],
    ["a file named for passwords", "password-notes.md"],
  ])("still edits an imported fact to add a labelled UUID when its path is %s", async (_label, relativePath) => {
    const id = await importedId(relativePath);
    const edited = await runCli(["edit", id, "--force", "--text", EDITED, "--root", home]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(`text: ${EDITED}`);
  });

  it("still refuses the edit when the imported bullet itself names a password", async () => {
    const path = join(home, "notes.md");
    writeFileSync(path, "- the staging box password lives in the wiki\n", "utf8");
    await runCli(["import", "--from-md", path, "--root", home]);
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec((await runCli(["list", "--status", "pending"])).stdout)?.[0] ?? "";
    expect(id).not.toBe("");
    expectRefused(await runCli(["edit", id, "--force", "--text", EDITED, "--root", home]));
  });
});

describe("a review reason is screened with the fact content it is recorded on", () => {
  it("refuses a --reject reason that names a password when the fact holds a labelled UUID", async () => {
    const id = await suggest(`session id ${U}`);
    expectRefused(await runCli(["review", "--reject", id, "--reason", "admin password"]));
    expect((await runCli(["show", id])).stdout).toContain("pending");
  });
});

describe("mem edit --undo screens the state it restores", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-uuid-root-"));
    mkdirSync(join(root, ".mem"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function editedAwayFromAllowlistedValue(): Promise<string> {
    writeFileSync(join(root, ".mem", "allowlist"), `${U}\n`, "utf8");
    const id = await remember(`the value ${U} here`, "--root", root);
    const edited = await runCli(["edit", id, "--force", "--text", "plain note", "--root", root]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    return id;
  }

  it("refuses an undo once the allowlist entry for the restored value is gone", async () => {
    const id = await editedAwayFromAllowlistedValue();
    writeFileSync(join(root, ".mem", "allowlist"), "", "utf8");
    expectRefused(await runCli(["edit", id, "--undo", "--root", root]));
    expect((await runCli(["show", id])).stdout).toContain("text: plain note");
  });

  it("restores an allowlisted value", async () => {
    const id = await editedAwayFromAllowlistedValue();
    const undone = await runCli(["edit", id, "--undo", "--root", root]);
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain(`text: the value ${U} here`);
  });
});
