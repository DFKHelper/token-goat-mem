import { beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Pins the seam's retrieval soft budget for every test that reaches `buildHintFormat` through the
 * CLI (`runCli` in-process, or a spawned bundle that inherits `process.env`).
 *
 * `src/cli.ts` reads this variable per call and forwards it as `retrievalBudgetMs` only on the
 * `--hint-format` path, so tests that call `buildHintFormat` directly with `retrievalBudgetMs: 0`
 * to prove exhaustion are untouched. Without this pin, a cold CI runner can spend the real 150ms
 * budget opening the database, and the seam then answers `TGMEM/2` with no fact-lines: the 0.4.0
 * release gate went red on Windows for exactly that reason. `tests/guards/seam-budget.test.ts`
 * requires this pin to exist.
 */
const RETRIEVAL_BUDGET_ENV = "TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS";
/** A soft budget no test machine can exceed. */
const NO_TRUNCATION_BUDGET_MS = "3600000";

/**
 * Keeps every snapshot `openDb` takes inside the temp home. Left unset, the default backup directory
 * is a *sibling* of the home (src/db.ts's `resolveBackupDir`), which would scatter
 * `mem-test-*-backups` directories across the OS temp dir that the cleanup below never removes.
 */
const BACKUP_DIR_ENV = "TOKEN_GOAT_MEM_BACKUP_DIR";

let tempDir: string;
let priorRetrievalBudget: string | undefined;
let priorBackupDir: string | undefined;

beforeAll(() => {
  // Create isolated temp directory for tests
  tempDir = mkdtempSync(join(tmpdir(), "mem-test-"));
  process.env.TOKEN_GOAT_MEM_HOME = tempDir;
  priorRetrievalBudget = process.env[RETRIEVAL_BUDGET_ENV];
  process.env[RETRIEVAL_BUDGET_ENV] = NO_TRUNCATION_BUDGET_MS;
  priorBackupDir = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = join(tempDir, "backups");
});

afterAll(() => {
  if (priorRetrievalBudget === undefined) {
    delete process.env[RETRIEVAL_BUDGET_ENV];
  } else {
    process.env[RETRIEVAL_BUDGET_ENV] = priorRetrievalBudget;
  }
  if (priorBackupDir === undefined) {
    delete process.env[BACKUP_DIR_ENV];
  } else {
    process.env[BACKUP_DIR_ENV] = priorBackupDir;
  }
  // Clean up temp directory
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
