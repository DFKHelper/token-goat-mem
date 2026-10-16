/** Guard tests over documentation claims to catch inconsistencies between docs and the actual implementation. */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { buildProgram } from "../../src/cli.js";
import { TOOL_NAMES } from "../../src/wiring.js";

const REPO_ROOT = join(import.meta.dirname, "../..");

const MAX_TABLE_CELL_LENGTH = 600;

const BACKSLASH = String.fromCharCode(92);

/** Splits one markdown table row into trimmed cells, keeping a backslash-escaped pipe and a pipe inside a code span inside its cell. */
function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === BACKSLASH && body.charAt(i + 1) === "|") {
      current += `${BACKSLASH}|`;
      i += 1;
    } else if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Every table cell over `limit` characters in `source`, as `<file>: <first cell of its row>`. */
function longTableCells(file: string, source: string, limit: number): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.trimStart().startsWith("|")) {
      continue;
    }
    const cells = splitTableRow(line);
    if (cells.some((cell) => cell.length > limit)) {
      found.push(`${file}: ${cells[0] ?? ""}`);
    }
  }
  return found;
}

/** The `mem <name>` commands an AGENTS.md bullet introduces: the backticked commands before its first " — ", so a line such as "`mem backup` / `mem restore`" covers both. */
function documentedCommands(agentsSource: string): Set<string> {
  const names = new Set<string>();
  for (const line of agentsSource.split("\n")) {
    if (!line.startsWith("- `mem ")) {
      continue;
    }
    const head = line.split(" — ")[0] ?? "";
    for (const match of head.matchAll(/`mem ([a-z][a-z-]*)/gu)) {
      names.add(match[1] ?? "");
    }
  }
  return names;
}

describe("documentation consistency guards", () => {
  // Helper to read files
  const readDocFile = (relativePath: string): string => {
    return readFileSync(join(REPO_ROOT, relativePath), "utf8");
  };

  // Get all doc files. Derived from TOOL_NAMES for the per-tool integration docs, so a new tool added to that list without a matching docs/integrations/<tool>.md fails this guard instead of shipping silently undocumented. README.md/AGENTS.md/CLAUDE.md are the fixed, non-per-tool entries.
  const getAllDocFiles = (): string[] => {
    return [
      "README.md",
      // AGENTS.md and CLAUDE.md are read by an agent every turn, so a false claim in either misleads more often than one in README -- they belong inside this guard, not outside it.
      "AGENTS.md",
      "CLAUDE.md",
      ...TOOL_NAMES.map((tool) => `docs/integrations/${tool}.md`),
    ];
  };

  describe("docs/claims-about-wiring", () => {
    it("no doc file contains the false claim 'No wiring needed' for token-goat integration", () => {
      const files = getAllDocFiles();
      for (const filePath of files) {
        const content = readDocFile(filePath);
        expect(
          content,
          `${filePath} must not claim "No wiring needed" for token-goat integration`
        ).not.toMatch(/No wiring needed/);
      }
    });

    it("no doc file claims token-goat calls, invokes, or runs 'mem recall'", () => {
      const files = getAllDocFiles();
      // Allows intervening words ("token-goat optionally calls") and optional backticks around the tool name: CLAUDE.md carried exactly that phrasing past the original stricter pattern.
      const pattern = /`?token-goat`?\s+(?:\w+\s+){0,2}(calls|invokes|runs)\s+`?mem recall/i;
      for (const filePath of files) {
        const content = readDocFile(filePath);
        expect(
          content,
          `${filePath} must not claim token-goat calls/invokes/runs 'mem recall'`
        ).not.toMatch(pattern);
      }
    });

    it("at least one doc mentions 'mem epoch' to prevent vacuous pass if docs deleted", () => {
      const files = getAllDocFiles();
      const hasMemEpoch = files.some((filePath) => {
        const content = readDocFile(filePath);
        return /mem epoch/i.test(content);
      });
      expect(hasMemEpoch, "at least one doc should mention 'mem epoch'").toBe(
        true
      );
    });
  });

  describe("AGENTS.md hook wiring claim", () => {
    it("AGENTS.md does not claim 'no hook manager' when one is actually wired", () => {
      const content = readDocFile("AGENTS.md");
      expect(
        content,
        "AGENTS.md must not say 'no hook manager is wired' when .githooks exists"
      ).not.toMatch(/no hook manager is wired yet/i);
    });

    it("package.json scripts.prepare points to .githooks", () => {
      const pkgJson = JSON.parse(readDocFile("package.json"));
      expect(pkgJson.scripts?.prepare).toMatch(/\.githooks/);
    });

    it(".githooks/pre-commit is tracked executable with an sh shebang and LF endings", () => {
      const preCommitPath = join(REPO_ROOT, ".githooks", "pre-commit");
      // POSIX git silently skips a hook whose index mode is not 100755, so the secret scan would never run there.
      const staged = spawnSync("git", ["ls-files", "-s", ".githooks/pre-commit"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000 });
      expect(staged.stdout.split(" ")[0], ".githooks/pre-commit must be tracked with index mode 100755 (git update-index --chmod=+x)").toBe("100755");
      const content = readFileSync(preCommitPath, "utf8");
      expect(content.split("\n")[0]).toBe("#!/bin/sh");
      expect(content).not.toContain("\r");
      if (process.platform !== "win32") {
        expect(statSync(preCommitPath).mode & 0o111, "working-tree mode must have an execute bit").not.toBe(0);
      }
    });
  });

  describe("epoch polling and state-mutation docs (Item 1 & 2)", () => {
    it("README epoch section mentions anchors as something not covered by epoch", () => {
      const content = readDocFile("README.md");
      const cheapPollingSection = content.match(
        /### Cheap polling with `mem epoch`[\s\S]*?(?=## )/
      )?.[0];
      expect(cheapPollingSection).toBeDefined();
      expect(
        cheapPollingSection,
        "README epoch section must mention 'anchor' to clarify epoch does not cover them"
      ).toMatch(/anchor/i);
    });

    it("README epoch section mentions decay or time as not covered by epoch", () => {
      const content = readDocFile("README.md");
      const cheapPollingSection = content.match(
        /### Cheap polling with `mem epoch`[\s\S]*?(?=## )/
      )?.[0];
      expect(cheapPollingSection).toBeDefined();
      expect(
        cheapPollingSection,
        "README epoch section must mention decay or time to clarify epoch does not cover them"
      ).toMatch(/decay|time/i);
    });

    it("AGENTS.md seam section mentions anchors as not covered by epoch", () => {
      const content = readDocFile("AGENTS.md");
      const seamSection = content.match(
        /## Token-Goat integration seam[\s\S]*?(?=## )/
      )?.[0];
      expect(seamSection).toBeDefined();
      expect(
        seamSection,
        "AGENTS.md seam section must mention 'anchor' to clarify epoch does not cover them"
      ).toMatch(/anchor/i);
    });

    it("AGENTS.md seam section mentions decay or time as not covered by epoch", () => {
      const content = readDocFile("AGENTS.md");
      const seamSection = content.match(
        /## Token-Goat integration seam[\s\S]*?(?=## )/
      )?.[0];
      expect(seamSection).toBeDefined();
      expect(
        seamSection,
        "AGENTS.md seam section must mention decay or time to clarify epoch does not cover them"
      ).toMatch(/decay|time/i);
    });

    it("cli.ts epoch description does not use bare 'cache invalidation key' phrase", () => {
      const content = readDocFile("src/cli.ts");
      const epochDescriptionMatch = content.match(
        /\.description\("Print the current write epoch[^"]*"\)/
      );
      expect(epochDescriptionMatch).toBeDefined();
      const description = epochDescriptionMatch?.[0] ?? "";
      expect(
        description,
        "cli.ts epoch description must not use bare 'cache invalidation key' without qualifying it as store-only"
      ).not.toMatch(/cache\s+invalidation\s+key[^a-z]/i);
    });

    it("README does not contain bare 'never mutates state' phrase without qualifying 'facts'", () => {
      const content = readDocFile("README.md");
      expect(
        content,
        "README must not claim epoch 'never mutates state' without clarifying it means 'facts' (schema migrations are allowed)"
      ).not.toMatch(/never mutates state/i);
    });

    it("README epoch section clarifies that it covers 'store writes only' or similar", () => {
      const content = readDocFile("README.md");
      const cheapPollingSection = content.match(
        /### Cheap polling with `mem epoch`[\s\S]*?(?=## )/
      )?.[0];
      expect(cheapPollingSection).toBeDefined();
      expect(
        cheapPollingSection,
        "README must clarify that epoch covers store writes only"
      ).toMatch(/store.*write|store.*only|write.*only/i);
    });
  });

  describe("network-egress claims (mem recall's UserPromptSubmit hook also reaches an embeddings endpoint when configured)", () => {
    const NETWORK_CLAIM_FILES = [
      "README.md",
      "AGENTS.md",
      "src/cli.ts",
      "src/dream.ts",
    ];

    it("no doc or source claims a single command is 'the only command/path that sends' fact text off the machine", () => {
      const pattern = /only (command|path)[^.]*sends/i;
      for (const filePath of NETWORK_CLAIM_FILES) {
        const content = readDocFile(filePath);
        expect(
          content,
          `${filePath} must not claim a single command/path is "the only" one that sends fact text off this machine -- ` +
            "mem recall sends the query text (including every prompt, via the UserPromptSubmit hook) whenever " +
            "TOKEN_GOAT_MEM_EMBED_URL/_MODEL are set, so no single command holds that title"
        ).not.toMatch(pattern);
      }
    });

    it("README and AGENTS.md do not claim mem is 'zero network' unconditionally", () => {
      for (const filePath of ["README.md", "AGENTS.md"]) {
        const content = readDocFile(filePath);
        expect(
          content,
          `${filePath} must not claim "zero network" -- network calls happen whenever ` +
            "TOKEN_GOAT_MEM_EMBED_URL/_MODEL or TOKEN_GOAT_MEM_DREAM_URL/_MODEL are configured"
        ).not.toMatch(/zero network/i);
      }
    });
  });

  describe("command coverage and table shape", () => {
    it("AGENTS.md has a '- `mem <name>' bullet for every command the CLI registers", () => {
      const documented = documentedCommands(readDocFile("AGENTS.md"));
      const registered = buildProgram().commands.map((command) => command.name());
      expect(registered.length, "the CLI registers commands").toBeGreaterThan(0);
      const missing = registered.filter((name) => !documented.has(name));
      expect(missing, `AGENTS.md has no "- \`mem <name>" bullet for: ${missing.join(", ")}`).toEqual([]);
    });

    it(`no markdown table cell in README.md or AGENTS.md is over ${MAX_TABLE_CELL_LENGTH} characters`, () => {
      const over = ["README.md", "AGENTS.md"].flatMap((file) => longTableCells(file, readDocFile(file), MAX_TABLE_CELL_LENGTH));
      expect(over, `table cells over ${MAX_TABLE_CELL_LENGTH} characters: move the detail into prose below the table and keep a short cell`).toEqual([]);
    });
  });
});
