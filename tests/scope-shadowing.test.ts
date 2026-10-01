/** End-to-end tests for specificity shadowing at recall: when an in-scope fact with a narrower scope shares a `subject` with a broader in-scope fact and their values differ, the narrower one wins and the broader one is withheld from that recall only -- never superseded or edited in the store. Driven through the real CLI (`remember`, `recall`, `recall --hint-format`, `show`) so `mem recall` and the TGMEM/2 seam are asserted to agree, since both reach `retrieve()`. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractRememberedId, runCli } from "./support/cli.js";

let home: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-shadow-test-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
  projectA = join(home, "projA");
  projectB = join(home, "projB");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(join(projectA, "packages", "web"), { recursive: true });
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function remember(text: string, args: readonly string[]): Promise<string> {
  const result = await runCli(["remember", text, "--kind", "preference", ...args]);
  expect(result.exitCode).toBe(0);
  return extractRememberedId(result);
}

async function recallIds(root: string, extra: readonly string[] = []): Promise<string> {
  const result = await runCli(["recall", "--root", root, ...extra]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

async function hint(root: string): Promise<string> {
  const result = await runCli(["recall", "--hint-format", "--root", root]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("a more specific same-subject fact overrides a global one at recall", () => {
  it("the project fact wins in its project, in `mem recall` and the hint seam alike", async () => {
    const globalId = await remember("global uses npm", ["--subject", "package-manager", "--value", "npm", "--scope", "global"]);
    const projectId = await remember("project uses pnpm", ["--subject", "package-manager", "--value", "pnpm", "--scope", "project", "--root", projectA]);

    const recalled = await recallIds(projectA);
    expect(recalled).toContain(projectId.slice(0, 8));
    expect(recalled).not.toContain(globalId.slice(0, 8));

    const hinted = await hint(projectA);
    expect(hinted).toContain(projectId.slice(0, 8));
    expect(hinted).not.toContain(globalId.slice(0, 8));

    // Withheld from this recall only: the store is untouched.
    const shown = await runCli(["show", globalId]);
    expect(shown.stdout).toContain("active");
    expect(shown.stdout).not.toContain("superseded");
  });

  it("the global fact still surfaces in a project with no override", async () => {
    const globalId = await remember("global uses npm", ["--subject", "package-manager", "--value", "npm", "--scope", "global"]);
    const projectId = await remember("project uses pnpm", ["--subject", "package-manager", "--value", "pnpm", "--scope", "project", "--root", projectA]);

    const recalled = await recallIds(projectB);
    expect(recalled).toContain(globalId.slice(0, 8));
    expect(recalled).not.toContain(projectId.slice(0, 8));
    expect(await hint(projectB)).toContain(globalId.slice(0, 8));
  });

  it("the same value is not shadowed (both keep surfacing)", async () => {
    const globalId = await remember("global uses pnpm", ["--subject", "package-manager", "--value", "pnpm", "--scope", "global"]);
    const projectId = await remember("project also pnpm, with detail", ["--subject", "package-manager", "--value", "pnpm", "--scope", "project", "--root", projectA]);

    const recalled = await recallIds(projectA);
    expect(recalled).toContain(globalId.slice(0, 8));
    expect(recalled).toContain(projectId.slice(0, 8));
    const hinted = await hint(projectA);
    expect(hinted).toContain(globalId.slice(0, 8));
    expect(hinted).toContain(projectId.slice(0, 8));
  });

  it("subject-less facts are unaffected", async () => {
    const globalId = await remember("global note about tooling", ["--scope", "global"]);
    const projectId = await remember("project note about tooling", ["--scope", "project", "--root", projectA]);

    const recalled = await recallIds(projectA);
    expect(recalled).toContain(globalId.slice(0, 8));
    expect(recalled).toContain(projectId.slice(0, 8));
    const hinted = await hint(projectA);
    expect(hinted).toContain(globalId.slice(0, 8));
    expect(hinted).toContain(projectId.slice(0, 8));
  });

  it("a pinned global is still overridden by the more specific fact", async () => {
    const globalId = await remember("global uses npm", ["--subject", "package-manager", "--value", "npm", "--scope", "global"]);
    expect((await runCli(["pin", globalId])).exitCode).toBe(0);
    const projectId = await remember("project uses pnpm", ["--subject", "package-manager", "--value", "pnpm", "--scope", "project", "--root", projectA]);

    const recalled = await recallIds(projectA);
    expect(recalled).toContain(projectId.slice(0, 8));
    expect(recalled).not.toContain(globalId.slice(0, 8));
    expect(await hint(projectA)).not.toContain(globalId.slice(0, 8));
  });

  it("a narrower fact whose anchor is contradicted does not hide the broader one", async () => {
    const globalId = await remember("global uses npm", ["--subject", "package-manager", "--value", "npm", "--scope", "global"]);
    const projectId = await remember("project uses pnpm", [
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
      "--scope",
      "project",
      "--root",
      projectA,
      "--anchor",
      "file-exists pnpm-lock.yaml",
    ]);

    const hinted = await hint(projectA);
    expect(hinted).toContain(globalId.slice(0, 8));
    expect(hinted).not.toContain(projectId.slice(0, 8));
    expect(await recallIds(projectA)).toContain(globalId.slice(0, 8));
  });

  it("the narrowest in-scope fact wins across three levels (path beats project beats global)", async () => {
    const globalId = await remember("global uses npm", ["--subject", "package-manager", "--value", "npm", "--scope", "global"]);
    const projectId = await remember("project uses pnpm", ["--subject", "package-manager", "--value", "pnpm", "--scope", "project", "--root", projectA]);
    const pathId = await remember("this package uses yarn", [
      "--subject",
      "package-manager",
      "--value",
      "yarn",
      "--scope",
      "path",
      "--root",
      projectA,
      "--path",
      "packages/web",
    ]);

    const recalled = await recallIds(projectA);
    expect(recalled).toContain(pathId.slice(0, 8));
    expect(recalled).not.toContain(projectId.slice(0, 8));
    expect(recalled).not.toContain(globalId.slice(0, 8));
  });
});
