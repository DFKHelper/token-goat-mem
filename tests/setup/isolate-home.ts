import { beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tempDir: string;

beforeAll(() => {
  // Create isolated temp directory for tests
  tempDir = mkdtempSync(join(tmpdir(), "mem-test-"));
  process.env.TOKEN_GOAT_MEM_HOME = tempDir;
});

afterAll(() => {
  // Clean up temp directory
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
