/** End-to-end CLI tests for scope binding and anchor evaluation: project identity, path scopes, and anchor verdicts across recall, review, and show. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { extractRememberedId, runCli } from "./support/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { insertFact, openStorage } from "../src/storage.js";
import { clearProjectIdentityCache, PROJECT_IDENTITY_ENV } from "../src/projectIdentity.js";
import { _clearAnchorMemoForTests } from "../src/anchors.js";

// Process launches on this machine take 1-10 s, past the capability probe budget (MEM_PROBE_TIMEOUT_MS in wiring.ts); the floor keeps capability tests from timing out on launch latency.
vi.mock("node:child_process", async (importOriginal) => (await import("./support/spawnTimeoutFloor.js")).withSpawnTimeoutFloor(await importOriginal<typeof import("node:child_process")>()));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

// --- regression: anchor roots resolve per fact, not per caller ---

describe("regression: review and show resolve anchor roots the way recall does", () => {
  it("does not list a valid project-scoped fact as contradicted when review runs from another project", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-proj-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-proj-b-"));
    writeFileSync(join(projA, "package.json"), "{}\n");
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "this project has a package json manifest",
        kind: "fact",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
        anchor: "file-exists package.json",
      });
      db.close();

      // projB has no package.json. Evaluated against the caller's root, the predicate denies a fact that is perfectly valid in its own project, and files it under the one review heading whose whole purpose is to invite the user to forget what it lists.
      const review = await runCli(["review", "--root", projB]);
      expect(review.exitCode).toBe(0);
      expect(review.stdout).not.toContain("this project has a package json manifest");

      // ...and recall, from that same foreign root, no longer surfaces it either -- it is bound to projA. Two surfaces disagreeing about one fact was the original defect here; they agree by omission now, where they used to agree only if recall affirmed a fact review had hidden.
      const fromForeign = await runCli(["recall", "package json manifest", "--root", projB]);
      expect(fromForeign.stdout).not.toContain("this project has a package json manifest");

      // From its own project the fact is present and affirmed -- excluded above by its binding, not by a contradicted anchor.
      const fromOwn = await runCli(["recall", "package json manifest", "--root", projA]);
      expect(fromOwn.stdout).toContain("this project has a package json manifest");
      expect(fromOwn.stdout).not.toContain("contradicted");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  it("does not use a path-scoped fact's file path as an anchor root in show", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-path-scope-"));
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "some notes\n");
    try {
      const db = openStorage(resolveDbPath());
      const inserted = insertFact(db, {
        text: "a fact scoped to one single file",
        kind: "fact",
        scope: "path",
        scopeRoot: notes,
        source_type: "user",
        anchor: "file-exists package.json",
      });
      db.close();

      // With no --root, the old `?? fact.scopeRoot` fallback took over, and for scope="path" scopeRoot is a *file*. Resolving a predicate beneath a file path can only fail, so show reported a confident contradiction that no other surface agreed with. The repo root this suite runs from does have a package.json, so the correct verdict here is affirmed.
      const shown = await runCli(["show", inserted.id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).not.toContain("freshness=contradicted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not list a valid path-scoped fact as anchor-contradicted when review runs from an unrelated root", async () => {
    // Unlike the project-scope case above, `anchorRootFor` has no special case for `path` scope at all -- it always hands the bare caller root to `evaluateAnchor` for anything that is not `project` scope. So `mem review --root <anywhere>` evaluated a path-scoped fact's anchor against wherever the reviewer happened to be standing, found the anchored file predictably missing there, and filed a perfectly valid fact under "anchor-contradicted (suppressed from ground truth)" -- the one heading that invites the user to forget it.
    const rootA = mkdtempSync(join(tmpdir(), "mem-path-review-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "mem-path-review-b-"));
    const target = join(rootA, "target.txt");
    writeFileSync(target, "x\n");
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "a path-scoped fact bound to target.txt",
        kind: "fact",
        scope: "path",
        scopeRoot: target,
        source_type: "user",
        anchor: "file-exists target.txt",
      });
      db.close();

      // rootB is unrelated and empty: not an ancestor of rootA, so the fact is not bound to it at all -- the review should say nothing about it, positive or negative.
      const review = await runCli(["review", "--root", rootB]);
      expect(review.exitCode).toBe(0);
      expect(review.stdout).not.toContain("a path-scoped fact bound to target.txt");
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("mem recall persists and reuses anchor verdicts across CLI invocations", () => {
  function seedContentAnchoredFact(root: string): string {
    const db = openStorage(resolveDbPath());
    const inserted = insertFact(db, {
      // `kind: "fact"` deliberately, not "preference": a preference's display always carries a "(verify)" caveat regardless of freshness (P6), which would make the affirmed/contradicted assertions below true for the wrong reason. A plain fact's display shows the freshness verdict itself.
      text: "uses pnpm not npm",
      kind: "fact",
      scope: "project",
      scopeRoot: root,
      source_type: "user",
      anchor: "file-contains config.json pnpm",
    });
    db.close();
    return inserted.id;
  }

  it("persists the verdict it computed, readable by a later, independent connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-cli-anchor-cache-"));
    try {
      writeFileSync(join(root, "config.json"), "pnpm");
      seedContentAnchoredFact(root);

      const recalled = await runCli(["recall", "pnpm", "--root", root]);
      expect(recalled.exitCode).toBe(0);
      expect(recalled.stdout).not.toContain("contradicted");

      // A fresh `openDb`, not the connection `mem recall` already closed.
      const db = openDb(resolveDbPath());
      const row = db
        .prepare<[string, string], { verdict: string }>("SELECT verdict FROM anchor_cache WHERE root = ? AND anchor = ?")
        .get(resolve(root), "file-contains config.json pnpm");
      db.close();
      expect(row).toEqual({ verdict: "affirmed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("actually reuses a prefetched row rather than silently missing and re-evaluating", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-cli-anchor-cache-"));
    try {
      writeFileSync(join(root, "config.json"), "pnpm");
      const factId = seedContentAnchoredFact(root);

      // One real call to learn the witness a genuine evaluation computes for this untouched file.
      await runCli(["recall", "pnpm", "--root", root]);

      // Overwrite the persisted verdict to one a fresh evaluation could never produce, keeping the same witness. If the prefetch's key form does not match what the flush wrote it under, `mem recall` misses the cache, re-evaluates for real, and this assertion fails even though every other behavior looks correct -- the exact silent-miss this test exists to catch.
      const db = openDb(resolveDbPath());
      db.prepare("UPDATE anchor_cache SET verdict = 'contradicted' WHERE root = ? AND anchor = ?").run(
        resolve(root),
        "file-contains config.json pnpm"
      );
      db.close();

      // A real second `mem recall` is a fresh OS process, so anchors.ts's in-process memo (module state `evaluateAnchor` checks before ever consulting the persistent store) starts empty. This test drives both calls through one long-lived `run()`, so it has to clear that memo itself to simulate the same starting condition -- without this, the first call's real "affirmed" verdict would still be sitting in the in-process memo and mask the persistent cache read this test exists to prove.
      _clearAnchorMemoForTests();

      const second = await runCli(["recall", "pnpm", "--root", root]);
      expect(second.stdout).toContain(factId.slice(0, 8));
      expect(second.stdout).toContain("contradicted, excluded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes nothing to anchor_cache when nothing anchored was recalled (empty buffer)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-cli-anchor-cache-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "no default exports",
        kind: "fact",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
      });
      db.close();

      const recalled = await runCli(["recall", "no default exports", "--root", root]);
      expect(recalled.exitCode).toBe(0);

      const check = openDb(resolveDbPath());
      const count = check.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM anchor_cache").get()?.n;
      check.close();
      expect(count).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a flush failure does not fail the recall", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-cli-anchor-cache-"));
    try {
      writeFileSync(join(root, "config.json"), "pnpm");
      seedContentAnchoredFact(root);

      // No warm-up call: `anchor_cache` starts empty, so this recall's evaluation is genuinely fresh and `persistAnchorVerdicts` has something to flush -- a reused, cache-hit verdict would leave the buffer empty and the trigger below would never fire. A trigger that fails every INSERT into `anchor_cache`, not a whole-database lock: locking the file also blocks the read phase's own `openStorage` (schema/pragma setup needs a brief write-capable open even for a read), which would fail the read this test needs to succeed and fail for the wrong reason. This isolates the failure to the write `persistAnchorVerdicts` makes, mirroring the doc comment's own "a read-only store" failure mode.
      const trigDb = openStorage(resolveDbPath());
      trigDb.exec(
        "CREATE TRIGGER block_anchor_cache_insert BEFORE INSERT ON anchor_cache BEGIN SELECT RAISE(ABORT, 'simulated flush failure'); END;"
      );
      trigDb.close();
      try {
        const result = await runCli(["recall", "pnpm", "--root", root]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("uses pnpm not npm");
        expect(result.stderr).toContain("could not mark facts surfaced");
      } finally {
        const cleanupDb = openStorage(resolveDbPath());
        cleanupDb.exec("DROP TRIGGER block_anchor_cache_insert");
        cleanupDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- regression: a path-scoped fact's anchor is evaluated against its persisted capture root ---

describe("regression: the hook path and the CLI path agree about the same fact", () => {
  // `src/integration-seam.ts` builds its own SELECT by hand rather than reusing storage.ts's, and that list has now silently dropped a needed column three times in three separate releases: `prior_status`, then `scope_repo` (which made every project fact invisible from a worktree), then `capture_root` (which caveated a fact the CLI affirmed). Each time the omission failed open -- no error, no crash, just a different answer on the path that runs unprompted on every session start and every prompt. The file's own comment already states the rule; a comment has now failed three times, so this asserts it instead. Comparing the two paths' *rendered* answers, rather than the SELECT's text, is what makes this catch the next omission too: any column that changes what a user is told will diverge here regardless of which column it is.
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mem-seam-agree-home-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = home;
    repo = mkdtempSync(join(tmpdir(), "mem-seam-agree-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports the same freshness for a path-scoped anchored fact through both paths", async () => {
    writeFileSync(join(repo, "pkg.txt"), "x", "utf8");
    await runCli([
      "remember", "the package ships a manifest", "--kind", "fact", "--scope", "path",
      "--path", "pkg.txt", "--root", repo, "--anchor", "file-exists pkg.txt",
    ]);

    // Plain recall affirms it: the anchored file is right there. Rendered ground truth carries no freshness caveat at all, which is what "affirmed" looks like on this path.
    const plain = await runCli(["recall", "--root", repo]);
    expect(plain.stdout).toContain("the package ships a manifest");
    expect(plain.stdout).not.toContain("unverified");

    // The hook path must reach the same verdict. Pre-fix it emitted `fresh=unverified` here, because its SELECT omitted `capture_root` and `anchorRootFor` cannot judge a path-scoped anchor without one.
    const hint = await runCli([
      "recall", "--hint-format", "--root", repo, "--context-files", join(repo, "pkg.txt"),
    ]);
    expect(hint.stdout).toContain("the package ships a manifest");
    expect(hint.stdout).toContain("fresh=affirmed");
    expect(hint.stdout).not.toContain("fresh=unverified");
  });
});

describe("regression: a path-scoped fact's anchor evaluates against its recorded capture root", () => {
  /** `<repo>/pkg`, matching the bug report's own reproduction (proj/pkg under proj). */
  function makePkg(repo: string): string {
    const pkg = join(repo, "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "pkg.txt"), "x\n", "utf8");
    return pkg;
  }

  it("answers against the capture root, not the caller's, when queried from an ancestor of it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-capture-root-"));
    try {
      const pkg = makePkg(repo);
      // True from `pkg` on both counts: `pkg.txt` exists there, `yarn.lock` does not yet.
      const exists = await runCli([
        "remember", "pkg.txt exists here", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-exists pkg.txt",
      ]);
      const existsId = extractRememberedId(exists);
      const absent = await runCli([
        "remember", "pkg has no yarn.lock", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-absent yarn.lock",
      ]);
      const absentId = extractRememberedId(absent);
      writeFileSync(join(pkg, "yarn.lock"), "x\n", "utf8");

      // Query from `repo` -- an ancestor of `pkg`, not `pkg` itself. This is the monorepo shape the capture-root column exists for: a hook runs recall at the repository root while the facts belong to a package inside it. Pre-fix, `anchorRootFor` handed both anchors the bare `--root repo` regardless of where the facts were captured, so `file-exists pkg.txt` resolved against `repo` (no `pkg.txt` directly under `repo`, wrongly `contradicted`) and `file-absent yarn.lock` resolved against `repo` (no `yarn.lock` directly under `repo` either, even though one now exists under `pkg`, wrongly a plain affirmed ground-truth fact) -- confidently wrong in both directions on the same query. The two expectations below are the exact inverse of those two wrong verdicts, which is what makes this a regression test rather than a restatement: the anchors now resolve against `pkg`, where `pkg.txt` does exist and `yarn.lock` now does too. If the caller's root ever comes back, both flip.
      const shownExists = JSON.parse((await runCli(["show", existsId, "--root", repo, "--json"])).stdout) as {
        freshness: string;
      };
      const shownAbsent = JSON.parse((await runCli(["show", absentId, "--root", repo, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shownExists.freshness).toBe("affirmed");
      expect(shownAbsent.freshness).toBe("contradicted");

      // The same inversion, seen through the command that acts on it: pre-fix this listed the fact whose file was present under the heading inviting the user to forget it, and omitted the one whose predicate had genuinely been broken.
      const review = await runCli(["review", "--root", repo, "--section", "contradicted"]);
      expect(review.stdout).not.toContain("pkg.txt exists here");
      expect(review.stdout).toContain("pkg has no yarn.lock");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("restores the capture root along with the anchor, so an undone edit is judged where it was", async () => {
    // `mem edit --anchor` re-points the capture root to the root it validated the new anchor against. Undo restored the anchor and left the root, so the original anchor came back pointed at the tree the *replacement* was written for: the fact reported `contradicted` from the repository root and `unverified` from its own package, and could never be affirmed anywhere again -- after a command whose help promises to restore "the fields it touched".
    const proj = mkdtempSync(join(tmpdir(), "mem-undo-root-"));
    try {
      const pkg = join(proj, "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "foo.txt"), "x", "utf8");
      writeFileSync(join(proj, "yarn.lock"), "x", "utf8");
      writeFileSync(join(proj, "top.txt"), "x", "utf8");

      // True of `pkg`, which has no yarn.lock of its own -- `proj` does, which is what makes the wrong root observable rather than merely theoretical.
      const captured = await runCli([
        "remember", "pkg has no yarn.lock", "--kind", "fact", "--scope", "path",
        "--path", "foo.txt", "--root", pkg, "--anchor", "file-absent yarn.lock",
      ]);
      const id = extractRememberedId(captured);
      const before = JSON.parse((await runCli(["show", id, "--root", pkg, "--json"])).stdout) as {
        freshness: string;
      };
      expect(before.freshness).toBe("affirmed");

      await runCli(["edit", id, "--force", "--anchor", "file-exists top.txt", "--root", proj]);
      const undone = await runCli(["edit", id, "--undo"]);
      expect(undone.exitCode ?? 0).toBe(0);

      const after = JSON.parse((await runCli(["show", id, "--root", pkg, "--json"])).stdout) as {
        freshness: string;
      };
      expect(after.freshness).toBe("affirmed");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("cannot affirm or contradict a filesystem anchor when the root it names is gone", async () => {
    // A predicate asks a question about a tree. Against a tree that is not there, `file-absent` affirmed (nothing is absent from a directory that does not exist) and `file-exists` contradicted, both read off nothing at all -- while `git-tracked` already said `unverified`, so the predicates disagreed with each other about the same absence. This is reachable by moving a project, importing a fact from another machine, or handing the hook a stale --root.
    const gone = mkdtempSync(join(tmpdir(), "mem-missing-root-"));
    const live = mkdtempSync(join(tmpdir(), "mem-missing-root-live-"));
    try {
      writeFileSync(join(gone, "foo.txt"), "x", "utf8");
      const absent = extractRememberedId(
        await runCli([
          "remember", "no lockfile here", "--kind", "fact", "--scope", "global",
          "--root", gone, "--anchor", "file-absent yarn.lock",
        ])
      );
      const exists = extractRememberedId(
        await runCli([
          "remember", "foo.txt is present", "--kind", "fact", "--scope", "global",
          "--root", gone, "--anchor", "file-exists foo.txt",
        ])
      );
      rmSync(gone, { recursive: true, force: true });

      const freshnessOf = async (id: string): Promise<string> => {
        const shown = JSON.parse((await runCli(["show", id, "--root", gone, "--json"])).stdout) as {
          freshness: string;
        };
        return shown.freshness;
      };
      expect(await freshnessOf(absent)).toBe("unverified");
      expect(await freshnessOf(exists)).toBe("unverified");

      // The date-only predicate is deliberately unaffected: it reads no path, so a missing root tells it nothing it needed.
      const dated = extractRememberedId(
        await runCli([
          "remember", "ships this decade", "--kind", "fact", "--scope", "global",
          "--root", live, "--anchor", "valid-until 2099-01-01",
        ])
      );
      const shownDated = JSON.parse((await runCli(["show", dated, "--root", gone, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shownDated.freshness).toBe("affirmed");
    } finally {
      rmSync(gone, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
    }
  });

  it("re-points the capture root when `mem edit` writes a new anchor, so the new anchor is judged where it was validated", async () => {
    // `mem edit --anchor` validates the new anchor's path against its own `--root`. If the stored capture root stayed at the original, the anchor would be written against one tree and read against another -- the same split this column exists to close, arriving by a different door.
    const first = mkdtempSync(join(tmpdir(), "mem-capture-root-a-"));
    const second = mkdtempSync(join(tmpdir(), "mem-capture-root-b-"));
    try {
      const pkg = makePkg(first);
      const captured = await runCli([
        "remember", "the package ships a manifest", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-exists pkg.txt",
      ]);
      const id = extractRememberedId(captured);

      // `marker.txt` exists only under `second`, so an anchor naming it can only be affirmed when it is evaluated there -- which is exactly where `mem edit` validated it.
      writeFileSync(join(second, "marker.txt"), "x", "utf8");
      const edited = await runCli(["edit", id, "--anchor", "file-exists marker.txt", "--root", second, "--force"]);
      expect(edited.exitCode ?? 0).toBe(0);

      const shown = JSON.parse((await runCli(["show", id, "--root", second, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shown.freshness).toBe("affirmed");
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("still yields the correct decisive verdict when queried from the capture root itself", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-capture-root-"));
    try {
      const pkg = makePkg(repo);
      const exists = await runCli([
        "remember", "pkg.txt exists here", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-exists pkg.txt",
      ]);
      const existsId = extractRememberedId(exists);
      const absent = await runCli([
        "remember", "pkg has no yarn.lock", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-absent yarn.lock",
      ]);
      const absentId = extractRememberedId(absent);
      writeFileSync(join(pkg, "yarn.lock"), "x\n", "utf8");

      const shownExists = JSON.parse((await runCli(["show", existsId, "--root", pkg, "--json"])).stdout) as {
        freshness: string;
      };
      const shownAbsent = JSON.parse((await runCli(["show", absentId, "--root", pkg, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shownExists.freshness).toBe("affirmed");
      expect(shownAbsent.freshness).toBe("contradicted");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("mem show does not report a decisive freshness verdict for a path-scoped fact from an unrelated directory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-capture-root-show-"));
    const unrelated = mkdtempSync(join(tmpdir(), "mem-capture-root-unrelated-"));
    try {
      const pkg = makePkg(repo);
      const remembered = await runCli([
        "remember", "pkg.txt exists here", "--kind", "fact", "--scope", "path", "--path", "pkg.txt",
        "--root", pkg, "--anchor", "file-exists pkg.txt",
      ]);
      const id = extractRememberedId(remembered);

      const shown = JSON.parse((await runCli(["show", id, "--root", unrelated, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shown.freshness).toBe("unverified");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it("yields unverified, never a decisive verdict, for a fact with a null capture_root regardless of query root", async () => {
    // Simulates a pre-migration row: written directly through `insertFact` the way an older mem version would have, with no `captureRoot` at all -- exactly the shape `capture_root TEXT` (nullable, no backfill) leaves on disk for every fact captured before this column existed.
    const dir = mkdtempSync(join(tmpdir(), "mem-null-capture-root-"));
    const target = join(dir, "target.txt");
    writeFileSync(target, "x\n", "utf8");
    try {
      const db = openStorage(resolveDbPath());
      const inserted = insertFact(db, {
        text: "a pre-migration path-scoped fact",
        kind: "fact",
        scope: "path",
        scopeRoot: target,
        source_type: "user",
        anchor: "file-exists target.txt",
      });
      db.close();
      expect(inserted.captureRoot ?? null).toBeNull();

      // Queried from the very directory the anchor's target actually lives in -- the one root a decisive verdict could conceivably be justified from -- and it is still `unverified`, per the "null capture_root -> never decisive" rule: mem has no recorded root to trust here, even though this particular query happens to line up with where the file is.
      const shown = JSON.parse((await runCli(["show", inserted.id, "--root", dir, "--json"])).stdout) as {
        freshness: string;
      };
      expect(shown.freshness).toBe("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- regression: recall binds facts to the project they were captured in ---

describe("regression: recall does not surface another project's facts", () => {
  it("excludes a project-scoped fact belonging to a different root, including under --scope project", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-recall-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-recall-b-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "deploys go out on Tuesdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys go out on Thursdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projB,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys always need a changelog entry",
        kind: "decision",
        scope: "global",
        scopeRoot: null,
        source_type: "user",
      });
      db.close();

      // `--root` used to reach only anchor evaluation, so the store was searched whole and a user standing in projB was told projA's release schedule.
      const fromB = await runCli(["recall", "deploys", "--root", projB]);
      expect(fromB.exitCode).toBe(0);
      expect(fromB.stdout).toContain("deploys go out on Thursdays");
      expect(fromB.stdout).not.toContain("deploys go out on Tuesdays");

      // Global facts are bound to no project and stay visible from either one.
      expect(fromB.stdout).toContain("deploys always need a changelog entry");

      // `--scope project` filtered on the scope *label*, so it narrowed to "scoped to some project" and still returned the wrong project's fact -- the exact shape of README's own example.
      const scoped = await runCli(["recall", "deploys", "--root", projB, "--scope", "project"]);
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stdout).toContain("deploys go out on Thursdays");
      expect(scoped.stdout).not.toContain("deploys go out on Tuesdays");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  it("a JSON-imported project-scoped fact is recallable from its bound root and not from another", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-import-recall-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-import-recall-b-"));
    const exportDir = mkdtempSync(join(tmpdir(), "mem-import-recall-export-"));
    try {
      const envelope = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        facts: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            text: "this repo deploys via a manual runbook",
            kind: "decision",
            subject: null,
            value: null,
            scope: "project",
            scopeRoot: projA,
            source_type: "user",
            source_ref: null,
            captured_at: "2026-01-01T00:00:00.000Z",
            anchor: null,
            status: "active",
            confidence: 1,
            embedding: null,
          },
        ],
      };
      const jsonPath = join(exportDir, "export.json");
      writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");

      // `--root projA` here, not the default cwd: `importFromJson` rejects a non-global fact whose recorded `scopeRoot` falls outside `--root`, unless the fact's `scopeRepo` identifies the same repository `--root` is a checkout of, in which case it is accepted and rebound to `--root` (the cross-machine-restore case, since the original `scopeRoot` path does not exist there). This fact has no `scopeRepo`, so the path binding is the only one available, and a full-fidelity restore must be run with `--root` set to (an ancestor of) its own recorded `scopeRoot` -- exactly how a real restore-into-the-same-project would be invoked.
      const imported = await runCli(["import", "--from-json", jsonPath, "--root", projA]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const fromA = await runCli(["recall", "manual runbook", "--root", projA]);
      expect(fromA.exitCode).toBe(0);
      expect(fromA.stdout).toContain("this repo deploys via a manual runbook");

      const fromB = await runCli(["recall", "manual runbook", "--root", projB]);
      expect(fromB.exitCode).toBe(0);
      expect(fromB.stdout).not.toContain("this repo deploys via a manual runbook");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("surfaces a path-scoped fact bound to a file inside the querying root", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-recall-path-"));
    const outside = mkdtempSync(join(tmpdir(), "mem-recall-out-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "this module owns retry backoff",
        kind: "fact",
        scope: "path",
        scopeRoot: join(proj, "src", "retry.ts"),
        source_type: "user",
      });
      insertFact(db, {
        text: "this module owns rate limiting",
        kind: "fact",
        scope: "path",
        scopeRoot: join(outside, "src", "limit.ts"),
        source_type: "user",
      });
      db.close();

      const recalled = await runCli(["recall", "module owns", "--root", proj]);
      expect(recalled.exitCode).toBe(0);
      expect(recalled.stdout).toContain("this module owns retry backoff");
      expect(recalled.stdout).not.toContain("this module owns rate limiting");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// --- regression: `--scope path` is reachable and binds to a file, not the project root ---

describe("regression: --scope path binds to --path, not --root (previously unreachable)", () => {
  it("mem remember --scope path --path <file> binds scopeRoot to the file, and `show` prints it", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-remember-"));
    try {
      const remembered = await runCli([
        "remember",
        "auth.ts owns migrations",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/auth.ts",
        "--root",
        proj,
      ]);
      expect(remembered.exitCode).toBe(0);
      const id = extractRememberedId(remembered);

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`scope: path (${join(proj, "src", "auth.ts")})`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("a path-scoped fact recalls only for a matching --context-files entry, not for an unrelated file in the same project", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-recall-"));
    try {
      const remembered = await runCli([
        "remember",
        "auth.ts owns migrations",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/auth.ts",
        "--root",
        proj,
      ]);
      expect(remembered.exitCode).toBe(0);

      const matching = await runCli([
        "recall",
        "--hint-format",
        "--root",
        proj,
        "--context-files",
        "src/auth.ts",
      ]);
      expect(matching.exitCode).toBe(0);
      expect(matching.stdout).toContain("auth.ts owns migrations");

      const nonMatching = await runCli([
        "recall",
        "--hint-format",
        "--root",
        proj,
        "--context-files",
        "src/other.ts",
      ]);
      expect(nonMatching.exitCode).toBe(0);
      expect(nonMatching.stdout).not.toContain("auth.ts owns migrations");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("a path-scoped fact recalls for its own project root when the caller supplies no --context-files at all -- the shape every hook mem init installs actually calls", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-no-context-files-"));
    try {
      const remembered = await runCli([
        "remember",
        "auth.ts owns migrations",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/auth.ts",
        "--root",
        proj,
      ]);
      expect(remembered.exitCode).toBe(0);

      const noContextFiles = await runCli(["recall", "--hint-format", "--root", proj]);
      expect(noContextFiles.exitCode).toBe(0);
      expect(noContextFiles.stdout).toContain("auth.ts owns migrations");

      const unrelatedRoot = mkdtempSync(join(tmpdir(), "mem-scope-path-no-context-files-unrelated-"));
      try {
        const outsideRoot = await runCli(["recall", "--hint-format", "--root", unrelatedRoot]);
        expect(outsideRoot.exitCode).toBe(0);
        expect(outsideRoot.stdout).not.toContain("auth.ts owns migrations");
      } finally {
        rmSync(unrelatedRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("rejects --scope path without --path", async () => {
    const result = await runCli(["remember", "some fact", "--kind", "fact", "--scope", "path"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--scope path requires --path <file-or-dir>");
  });

  it("rejects --path without --scope path", async () => {
    const result = await runCli(["remember", "some fact", "--kind", "fact", "--path", "src/auth.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--path requires --scope path");
  });

  it("mem remember --scope path --path <escaping-relative-path> is rejected, not bound outside --root", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-escape-remember-"));
    try {
      const result = await runCli([
        "remember",
        "escapes the project root",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "../../etc/passwd",
        "--root",
        proj,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resolves outside --root");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("mem edit --scope path --path <escaping-relative-path> is rejected, not bound outside --root", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-escape-edit-"));
    try {
      const remembered = await runCli([
        "remember",
        "a.ts owns retries",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/a.ts",
        "--root",
        proj,
      ]);
      const id = extractRememberedId(remembered);

      const edited = await runCli(["edit", id, "--scope", "path", "--path", "../../etc/passwd", "--root", proj, "--force"]);
      expect(edited.exitCode).toBe(1);
      expect(edited.stderr).toContain("resolves outside --root");

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`scope: path (${join(proj, "src", "a.ts")})`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("mem edit --scope path --path <file> rebinds scopeRoot to the new file", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-edit-"));
    try {
      const remembered = await runCli([
        "remember",
        "b.ts owns retries",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/a.ts",
        "--root",
        proj,
      ]);
      const id = extractRememberedId(remembered);

      const edited = await runCli(["edit", id, "--scope", "path", "--path", "src/b.ts", "--root", proj, "--force"]);
      expect(edited.exitCode).toBe(0);

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`scope: path (${join(proj, "src", "b.ts")})`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// --- regression: `mem list` cannot tell projects apart ---

describe("regression: mem list distinguishes facts bound to different projects", () => {
  it("shows the project binding on a project-scoped fact's summary line, and no binding on a global fact's", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-list-scope-a-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "deploys go out on Tuesdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys always need a changelog entry",
        kind: "decision",
        scope: "global",
        scopeRoot: null,
        source_type: "user",
      });
      db.close();

      const listed = await runCli(["list"]);
      expect(listed.exitCode).toBe(0);

      const projectLine = listed.stdout.split("\n").find((line) => line.includes("deploys go out on Tuesdays"));
      expect(projectLine).toBeDefined();
      expect(projectLine).toContain(`@${projA}`);

      const globalLine = listed.stdout.split("\n").find((line) => line.includes("deploys always need a changelog entry"));
      expect(globalLine).toBeDefined();
      expect(globalLine).not.toContain("@");
    } finally {
      rmSync(projA, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── project identity ───────────────────────────────────────────────────────────────────────────

describe("project identity (scope binding across checkouts)", () => {
  let work: string;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  }

  function makeRepo(name: string, remote: string | null = "https://github.com/acme/widget.git"): string {
    const repo = join(work, name);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "x", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    if (remote !== null) {
      git(repo, "remote", "add", "origin", remote);
    }
    return repo;
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "mem-identity-cli-"));
    delete process.env[PROJECT_IDENTITY_ENV];
    clearProjectIdentityCache();
  });

  afterEach(() => {
    delete process.env[PROJECT_IDENTITY_ENV];
    clearProjectIdentityCache();
    rmSync(work, { recursive: true, force: true });
  });

  it("surfaces a project fact in a second checkout of the same repository", async () => {
    // The gap this closes: `scopeRoot` is an absolute path compared by equality, so cloning a repo to a second path -- or opening a worktree -- left every fact about that project invisible.
    const a = makeRepo("a");
    const b = makeRepo("b");
    await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", a]);

    expect((await runCli(["recall", "--root", a, "--scope", "project"])).stdout).toContain("esbuild");
    expect((await runCli(["recall", "--root", b, "--scope", "project"])).stdout).toContain("esbuild");
  });

  it("regression: an identity-bound fact's anchor is re-evaluated against the querying checkout, not its capture-time root", async () => {
    // A `project` fact surfaces across checkouts that share an identity (the test just above), but `anchorRootFor` used to hand the anchor predicate the fact's *capture-time* `scopeRoot` unconditionally -- so a fact captured in checkout `a` and recalled from checkout `b` had its anchor evaluated against `a`, not `b`. A marker file present only in `b` therefore read as absent, and `mem recall --root b` reported `contradicted` for ground truth read off a tree the user was not in.
    const a = makeRepo("a");
    const b = makeRepo("b");
    writeFileSync(join(b, "marker"), "x", "utf8");
    const remembered = await runCli([
      "remember",
      "the widget build has a marker file",
      "--kind",
      "fact",
      "--scope",
      "project",
      "--root",
      a,
      "--anchor",
      "file-exists marker",
    ]);
    const id = extractRememberedId(remembered);
    const shownFromB = JSON.parse((await runCli(["show", id, "--root", b, "--json"])).stdout) as { freshness: string };
    expect(shownFromB.freshness).toBe("affirmed");
  });

  it("does not leak between two packages of one monorepo", async () => {
    // One remote, many project roots: identity has to carry the subpath or `packages/a`'s decisions would surface as `packages/b`'s.
    const repo = makeRepo("mono");
    const a = join(repo, "packages", "a");
    const b = join(repo, "packages", "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    await runCli(["remember", "package a targets node 18", "--kind", "fact", "--scope", "project", "--root", a]);

    expect((await runCli(["recall", "--root", a, "--scope", "project"])).stdout).toContain("node 18");
    expect((await runCli(["recall", "--root", b, "--scope", "project"])).stdout).not.toContain("node 18");
    expect((await runCli(["recall", "--root", repo, "--scope", "project"])).stdout).not.toContain("node 18");
  });

  it("does not leak between unrelated repositories", async () => {
    const widget = makeRepo("widget");
    const gadget = makeRepo("gadget", "https://github.com/acme/gadget.git");
    await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", widget]);
    expect((await runCli(["recall", "--root", gadget, "--scope", "project"])).stdout).not.toContain("esbuild");
  });

  it("still binds by path when no identity is available", async () => {
    // A directory that is not a repository, or a repository with no remote, behaves exactly as it did before identities existed -- the path binding is never weakened, only widened.
    const local = makeRepo("local", null);
    const other = makeRepo("other", null);
    await runCli(["remember", "local checkout uses make", "--kind", "fact", "--scope", "project", "--root", local]);
    expect((await runCli(["recall", "--root", local, "--scope", "project"])).stdout).toContain("make");
    expect((await runCli(["recall", "--root", other, "--scope", "project"])).stdout).not.toContain("make");
  });

  it("records no identity, and matches none, under the path-only opt-out", async () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    process.env[PROJECT_IDENTITY_ENV] = "path";
    clearProjectIdentityCache();
    await runCli(["remember", "the widget build uses rollup", "--kind", "fact", "--scope", "project", "--root", a]);

    const listed = JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: { scopeRepo: string | null }[] };
    expect(listed.facts[0]?.scopeRepo).toBeNull();
    expect((await runCli(["recall", "--root", b, "--scope", "project"])).stdout).not.toContain("rollup");
    // And the fact stays where it was captured, rather than being lost along with its identity.
    expect((await runCli(["recall", "--root", a, "--scope", "project"])).stdout).toContain("rollup");
  });

  it("preserves an imported fact's own identity rather than rebinding it to the importing checkout", async () => {
    // Re-deriving on import would silently rebind every imported fact to whatever repository the importer happened to be standing in.
    const a = makeRepo("a");
    const gadget = makeRepo("gadget", "https://github.com/acme/gadget.git");
    await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", a]);
    const exported = (await runCli(["export"])).stdout;
    const exportPath = join(work, "export.json");
    writeFileSync(exportPath, exported, "utf8");

    await runCli(["forget", (JSON.parse(exported) as { facts: { id: string }[] }).facts[0]?.id ?? ""]);
    await runCli(["import", "--from-json", exportPath, "--root", gadget]);

    const listed = JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: { scopeRepo: string | null }[] };
    expect(listed.facts[0]?.scopeRepo).toBe("github.com/acme/widget#.");
    expect((await runCli(["recall", "--root", gadget, "--scope", "project"])).stdout).not.toContain("esbuild");
  });

  it("mem doctor does not call an identity-bound fact unreachable once its capture-time root is gone", async () => {
    // `mem doctor` used to group solely by `scope_root` and report every fact whose root no longer exists as unreachable, suggesting `mem forget` -- but recall binds a project fact by `scope_root` OR repository identity, so a fact carrying `scope_repo` is still recallable from any other checkout of the same repository after this one is removed or re-cloned elsewhere.
    const repo = makeRepo("doomed-but-identified");
    await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", repo]);
    rmSync(repo, { recursive: true, force: true });

    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("active=1");
    expect(result.stdout).not.toContain("unreachable from any session");
    expect(result.stdout).toContain("still reachable by repository identity from any checkout");
  });

  it("mem edit --scope project writes scopeRepo, so a second checkout of the same repository sees the rebound fact", async () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const remembered = await runCli(["remember", "shared config lives in a monorepo package", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const edited = await runCli(["edit", id, "--scope", "project", "--root", a, "--force"]);
    expect(edited.exitCode).toBe(0);

    const listed = JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: { id: string; scopeRepo: string | null }[] };
    expect(listed.facts.find((fact) => fact.id === id)?.scopeRepo).not.toBeNull();

    // The identity match, not the path match, is what has to carry this: `b` never appeared in the fact's own scopeRoot.
    expect((await runCli(["recall", "--root", b, "--scope", "project"])).stdout).toContain("monorepo package");
  });

  it("mem edit --scope project rebinding to a second repository moves visibility -- new repo sees it, old repo stops", async () => {
    const widget = makeRepo("widget-rebind");
    const gadget = makeRepo("gadget-rebind", "https://github.com/acme/gadget.git");
    const remembered = await runCli([
      "remember",
      "the build target is fly.io",
      "--kind",
      "fact",
      "--scope",
      "project",
      "--root",
      widget,
    ]);
    const id = extractRememberedId(remembered);
    expect((await runCli(["recall", "--root", widget, "--scope", "project"])).stdout).toContain("fly.io");

    const edited = await runCli(["edit", id, "--scope", "project", "--root", gadget, "--force"]);
    expect(edited.exitCode).toBe(0);

    expect((await runCli(["recall", "--root", gadget, "--scope", "project"])).stdout).toContain("fly.io");
    expect((await runCli(["recall", "--root", widget, "--scope", "project"])).stdout).not.toContain("fly.io");
  });
});
