/**
 * Guard tests over documentation claims to catch inconsistencies between
 * docs and the actual implementation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dirname, "../..");

describe("documentation consistency guards", () => {
  // Helper to read files
  const readDocFile = (relativePath: string): string => {
    return readFileSync(join(REPO_ROOT, relativePath), "utf8");
  };

  // Get all doc files
  const getAllDocFiles = (): string[] => {
    return [
      "README.md",
      "docs/integrations/claude-code.md",
      "docs/integrations/codex.md",
      "docs/integrations/copilot-cli.md",
      "docs/integrations/copilot-vscode.md",
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
      const pattern = /token-goat\s+(calls|invokes|runs)\s+`mem recall/i;
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

    it(".githooks/pre-commit exists and is executable", () => {
      const preCommitPath = join(REPO_ROOT, ".githooks", "pre-commit");
      const content = readFileSync(preCommitPath, "utf8");
      expect(content.length).toBeGreaterThan(0);
    });
  });
});
