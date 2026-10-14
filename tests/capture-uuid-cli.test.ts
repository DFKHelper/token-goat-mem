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

describe("mem import --from-md reads the section, not the file name, for credential keywords", () => {
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

  it("files a labelled bullet in a file named for passwords, since the file name is not credential context (I3)", async () => {
    expect(await importFile("passwords.md", ["## Prod", "", `- the session id is ${U}`])).toContain(U);
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

  it("refuses a labelled AWS secret access key in a source ref", async () => {
    expectRefused(await runCli(["remember", "The AWS secret access key is recorded in the source reference", "--kind", "fact", "--scope", "global", "--source-ref", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"]));
  });

  it.each(["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY:1", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY#turn3", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY.md:1"])("refuses a labelled AWS secret access key that carries a pointer suffix: %s", async (sourceRef) => {
    expectRefused(await runCli(["remember", "The AWS secret access key is noted in the source reference", "--kind", "fact", "--scope", "global", "--source-ref", sourceRef]));
  });

  it("refuses a bare labelled UUID in a source ref", async () => {
    expectRefused(await runCli(["remember", "x", "--kind", "fact", "--scope", "global", "--source-ref", `session id ${U}`]));
  });

  it.each([
    "docs/security/notes.md:7",
    "Users/Zelys/Projects/My-Very-Long-Project-Name/Docs/ApiKeys/NOTES.md:7",
    `C:/Users/Zelys/.claude/projects/C--Projects-x/${U.toUpperCase()}.jsonl:42`,
    "/Users/dev/OAuth2Client/src/AuthService.ts:42",
    "C:/Users/Zelys/GitHub/XMLParserTools/docs/notes.md:3",
    "/Users/dev/iOSAppProject/Docs/README.md:3",
  ])("stores a word-shaped path pointer as a source ref beside a credential phrase: %s", async (sourceRef) => {
    const result = await runCli(["remember", "The AWS secret access key is noted in the source reference", "--kind", "fact", "--scope", "global", "--source-ref", sourceRef]);
    expect(result.exitCode, result.stderr).toBe(0);
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

describe("a hex value is refused when a credential label follows it, and a directional mark does not hide it", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const HEX40 = "0123456789abcdef0123456789abcdef01234567";

  it.each([
    ["a trailing production API key label", `${HEX32} is the production API key`],
    ["a trailing token label", `${HEX32} was the token for staging`],
    ["a trailing api_key label", `${HEX32} is our api_key`],
    ["a Spanish contrasena label", `${HEX32} es mi contrase${String.fromCharCode(0xf1)}a`],
    ["a German Passwort label", `${HEX32} ist mein Passwort`],
    ["a totp label", `${HEX32} is my totp`],
    ["a lowercase refreshtoken compound", `${HEX32} is my refreshtoken`],
    ["a lowercase clientsecret compound", `${HEX32} is the clientsecret`],
    ["a webhooksecret compound", `${HEX32} is the webhooksecret`],
    ["a passkey compound", `${HEX32} is my passkey`],
    ["an apikey compound", `${HEX32} is the apikey`],
    ["a vault label", `${HEX32} is the vault password`],
    ["a lowercase sessioncookie compound", `${HEX32} is the sessioncookie`],
    ["an authtoken compound", `${HEX32} is my authtoken`],
    ["a plural apikeys compound", `${HEX32} are the apikeys`],
    ["a plural sshkeys compound", `${HEX32} are the sshkeys`],
    ["a plural refreshtokens compound", `${HEX32} are my refreshtokens`],
    ["a label in a following sentence that opens with This", `Here's the value: ${HEX32}. This is my API key.`],
    ["a label in a following sentence that opens with It", `${HEX32}. It is the deploy token.`],
    // Pinned trade-off: a label one sentence boundary away stays refused.
    ["a label in the sentence right after a bare 32-hex sentence", `${HEX32}. This is my API key`],
    // Pinned trade-off: bare no/st/v/al/vol read as abbreviations everywhere, so this fails closed, and only when a credential word follows.
    ["a bare label after the bare abbreviation No.", `${HEX40}. No. Password`],
    ["a bare one-word label after a full stop at the end of a line", `${HEX32}. Password`],
    ["a bare two-word label after a full stop", `${HEX32}. Deploy token`],
    ["a label inside an e.g. parenthesis", `${HEX32} (e.g. the token)`],
    ["a label after i.e.", `${HEX32}, i.e. the secret`],
    ["a label in a sentence that opens with The above", `${HEX32}. The above is my password`],
    ["a label in a sentence that opens with The former", `${HEX32}. The former is the API key`],
    ["a label in a sentence that opens with The latter", `${HEX32}. The latter is the deploy token`],
    ["a label in a sentence that opens with Said", `${HEX32}. Said value is my password`],
    ["a label after a title abbreviation in the next sentence", `${HEX32}. Mr. Smith's password.`],
    ["a label inside an approx. parenthesis", `${HEX32} (approx. the token for staging)`],
    ["a label after cf.", `${HEX32} cf. the deploy token for staging`],
    ["a label after Mr.", `${HEX32}, Mr. Smith's password for staging`],
    ["a label after a title and a single-letter initial", `${HEX32}. Mr. J. Api Key`],
    ["a label after a title, an initial and a surname", `${HEX32}. Dr. J. Smith Api Key`],
    ["a label after the title Prof.", `${HEX32}. Prof. Smith Api Key`],
    ["a label after a title with no dot", `${HEX32}. Mr Smith Api Key`],
    ...["mr", "mrs", "ms", "dr", "approx", "cf", "no", "vol", "fig", "al", "st", "v"].map((abbreviation): [string, string] => [`a label after the abbreviation ${abbreviation}.`, `${HEX32} ${abbreviation}. the deploy token for staging`]),
    ["a hex split by U+200E", `API key: 0123456789abcdef${String.fromCodePoint(0x200e)}0123456789abcdef`],
    ["a hex split by U+2066", `API key: 0123456789abcdef${String.fromCodePoint(0x2066)}0123456789abcdef`],
    ["a hex split by U+FE0F", `API key: 0123456789abcdef${String.fromCodePoint(0xfe0f)}0123456789abcdef`],
  ])("refuses %s", async (_label, text) => {
    expectRefused(await runCli(["remember", text, "--kind", "fact", "--scope", "global"]));
  });

  it.each([
    ["a commit mention", `commit ${HEX40} fixed the parser`],
    ["a commit sentence", `${HEX40} is the commit that fixed the parser`],
    ["a word that merely starts with a keyword", `Fixed in ${HEX40} by renaming the keyboard shortcut handler`],
    ["words that merely end with a keyword", `${HEX40} fixed the monkey patch in the authors list`],
    ["a keyword in a later sentence", `${HEX40} was reverted. The deploy key rotation is separate`],
    ["login in ordinary prose", `${HEX40} fixed the login page`],
    ["auth in ordinary prose", `${HEX40} fixed the auth flow`],
    ["cookie in ordinary prose", `${HEX40} moved the cookie banner`],
    ["a referring sentence that carries no label", `${HEX40} was reverted. It fixed the parser.`],
    ["a long unrelated sentence after a full stop", `${HEX40} was reverted. The deploy token cache is separate work for later`],
    ["a word that merely ends in a short keyword", `${HEX40} fixed the turkey and hockey fixtures`],
    ["a word that merely starts with a short keyword", `${HEX40} fixed the saltwater and pinball tests`],
    ["an ordinary plural ending in key", `${HEX40} fixed the monkeys test`],
    ["an ordinary plural starting with a keyword", `${HEX40} renamed the keyboards module`],
    ["a short sentence chain whose last sentence is a long unrelated one", `${HEX40} merged. Done. Tests green. Next the token refresh work`],
    ["a short sentence chain ending in a short sentence that names a token", `${HEX40} merged. Done. Tests green. Token refresh next`],
    ["a short sentence chain ending in a bare password mention", `${HEX40} merged. Done. Password reset next`],
    // Pinned trade-off: the bare abbreviation No. is not a sentence end, but with no credential word after it the text is stored.
    ["a bare No. abbreviation followed by a harmless sentence", `${HEX40}. No. Tests are green.`],
    // Pinned trade-off: continuation reaches one sentence boundary past the hex sentence, so a label two boundaries away is stored to keep short harmless chains.
    ["a label two sentence boundaries after the hex sentence", `Merged ${HEX40}. Done. This is my API key`],
    ["a Said sentence whose later clause names a form", `Merged ${HEX40}. Said Alice, please fix the password form.`],
    ["a commit after an abbreviated title",`Fixed by Dr. Jones in ${HEX40}; the keyboard layout changed`],
    ["a credential word that is the surname of a titled name", `Merged ${HEX40}. Dr. Key reviewed the release notes.`],
    ["a credential word that is the middle name of a titled name", `Merged ${HEX40}. Mr. Token Smith signed off the release.`],
    ["a credential word that is the first name of a titled name", `Merged ${HEX40}. Mrs. Password Jones joined the team.`],
    ["a titled name with an initial and no label", `Merged ${HEX40}. Prof. J. Smith signed off the release.`],
    ["a titled name with no dot and no label", `Merged ${HEX40}. Mr Smith signed off the release.`],
    ["cf. before an unrelated phrase", `${HEX40} cf. the release notes`],
  ])("stores %s", async (_label, text) => {
    await remember(text);
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

describe("the anchor and a typed source ref are credential context, an import directory is not", () => {
  it("refuses a labelled UUID when the anchor arguments name a password", async () => {
    expectRefused(await runCli(["remember", `session id ${U}`, "--kind", "fact", "--scope", "global", "--anchor", "file-contains password.txt x"]));
  });

  it("refuses a labelled UUID when a typed source ref names a password", async () => {
    expectRefused(await runCli(["remember", `session id ${U}`, "--kind", "fact", "--scope", "global", "--source-ref", "password notes"]));
  });

  it("files a labelled bullet in a file under a directory named for secrets, since the path is not credential context", async () => {
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "g.md"), ["## Prod", "", `- the session id is ${U}`].join("\n"), "utf8");
    await runCli(["import", "--from-md", join(home, "secrets", "g.md"), "--root", home]);
    expect((await runCli(["list", "--status", "pending"])).stdout).toContain(U);
  });
});

describe("a directory named api key does not make an imported UUID credential-adjacent", () => {
  async function importUnderApiKeyDirectory(bullet: string): Promise<string> {
    mkdirSync(join(home, "api key"));
    const path = join(home, "api key", "notes.md");
    writeFileSync(path, ["## Prod", "", bullet].join("\n"), "utf8");
    const imported = await runCli(["import", "--from-md", path, "--root", home]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    return (await runCli(["list", "--status", "pending"])).stdout;
  }

  it("imports a session id bullet as pending", async () => {
    expect(await importUnderApiKeyDirectory(`- session id ${U}`)).toContain(U);
  });

  it("still refuses a bullet that itself says api key", async () => {
    expect(await importUnderApiKeyDirectory(`- api key ${U}`)).not.toContain(U);
  });
});

describe("a canonical-length hex value or a bare anchor UUID is refused under credential words and stores nothing", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const LOW = "11111111-1111-1111-1111-111111111111";

  async function storedFactCount(): Promise<number> {
    return (JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: unknown[] }).facts.length;
  }

  it("refuses a 32-hex value right after api key", async () => {
    expectRefused(await runCli(["remember", `api key ${HEX32}`, "--kind", "fact", "--scope", "global"]));
    expect(await storedFactCount()).toBe(0);
  });

  it("refuses a bare uuid that only the anchor holds when the fact text names an api key", async () => {
    expectRefused(await runCli(["remember", "the api key lives in config.json", "--kind", "fact", "--scope", "global", "--anchor", `file-contains config.json ${LOW}`]));
    expect(await storedFactCount()).toBe(0);
  });

  it("stores an md5 checksum mention and a uuid path segment in the anchor", async () => {
    await remember(`md5 checksum ${HEX32}`);
    await remember("the api key lives in config.json", "--anchor", `file-exists logs/${LOW}/out.txt`);
    expect(await storedFactCount()).toBe(2);
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

describe("a project directory name with acronyms or digits does not cost a scan-session or import capture its credential statement", () => {
  const SESSION_TURN = "Remember that the staging database password is rotated monthly.";
  const BULLET = "Always rotate the staging database password every month.";

  async function pendingListing(): Promise<string> {
    return (await runCli(["list", "--status", "pending"])).stdout;
  }

  it.each(["MyAPIClient", "OAuth2Client", "FooBARBazQUXQuux"])("files a scan-session suggestion from a transcript under %s", async (project) => {
    const directory = join(home, ".claude", "projects", `C--Projects-${project}`);
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, `${U}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: SESSION_TURN }] } }), "utf8");
    const scanned = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(scanned.exitCode, scanned.stderr).toBe(0);
    expect(await pendingListing()).toContain("staging database password is rotated monthly");
  });

  it.each(["MyAPIClient-and-more-directory", "OAuth2Client-service-repo-dir", "FooBARBazQUXQuux-notes-dir"])("imports a credential bullet from NOTES.md under %s", async (directoryName) => {
    const directory = join(home, directoryName);
    mkdirSync(directory);
    const notes = join(directory, "NOTES.md");
    writeFileSync(notes, `- ${BULLET}\n`, "utf8");
    const imported = await runCli(["import", "--from-md", notes, "--root", home]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(await pendingListing()).toContain("rotate the staging database password every month");
  });

  it("refuses a typed ref with the stamped shape, since mem suggest never marks a ref as stamped", async () => {
    const result = await runCli(["suggest", "The AWS secret access key is noted in the source reference", "--kind", "fact", "--scope", "global", "--source-ref", `/home/u/.claude/projects/-home-u-FooBARBazQUXQuux/${U}.jsonl#turn3`]);
    expectRefused(result);
  });
});
