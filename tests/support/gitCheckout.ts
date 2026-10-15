/** Writes a git checkout's identity-bearing files with fs only, so a test that needs a repository identity (src/projectIdentity.ts reads `.git/config`, a `.git` pointer file and `commondir`, nothing else) launches no `git` process. A checkout that needs a real index or refs (the `git-tracked` anchor) is not this helper's job. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What a written checkout carries beyond an empty repository. */
export interface CheckoutOptions {
  /** Remote name to URL, written in insertion order into `.git/config`; none writes a remote-less checkout. */
  readonly remotes?: Readonly<Record<string, string>>;
}

/** The `.git/config` text of a repository with `remotes`, laid out the way `git init` followed by `git remote add` leaves it. */
function configText(remotes: Readonly<Record<string, string>>): string {
  const sections = ["[core]", "\trepositoryformatversion = 0", "\tfilemode = false", "\tbare = false"];
  for (const [name, url] of Object.entries(remotes)) {
    sections.push(`[remote "${name}"]`, `\turl = ${url}`, `\tfetch = +refs/heads/*:refs/remotes/${name}/*`);
  }
  return `${sections.join("\n")}\n`;
}

/** Turns the directory `repo` (created when absent) into a checkout whose `.git` directory holds `HEAD` and `config`, and returns `repo`. */
export function writeCheckout(repo: string, options: CheckoutOptions = {}): string {
  const gitDir = join(repo, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(gitDir, "config"), configText(options.remotes ?? {}), "utf8");
  return repo;
}

/** Turns `worktree` (created when absent) into a linked worktree of the checkout `mainRepo`, laid out the way `git worktree add` leaves it: a `.git` pointer file naming a private git directory under `<mainRepo>/.git/worktrees/<name>`, whose `commondir` leads back to the main git directory that holds the `config`. Returns `worktree`. */
export function writeWorktree(mainRepo: string, worktree: string, name = "wt"): string {
  const privateDir = join(mainRepo, ".git", "worktrees", name);
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(privateDir, "HEAD"), "ref: refs/heads/feature\n", "utf8");
  writeFileSync(join(privateDir, "commondir"), "../..\n", "utf8");
  writeFileSync(join(privateDir, "gitdir"), `${join(resolve(worktree), ".git").replaceAll("\\", "/")}\n`, "utf8");
  writeFileSync(join(worktree, ".git"), `gitdir: ${resolve(privateDir).replaceAll("\\", "/")}\n`, "utf8");
  return worktree;
}
