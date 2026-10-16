import { afterEach, beforeEach } from "vitest";

const NO_FSYNC_ENV = "TOKEN_GOAT_MEM_TEST_UNSAFE_NO_FSYNC";

/** Registers hooks that leave the no-fsync switch unset for each test of the calling file, so every store it opens (in-process, in a worker thread, or in a child that inherits `process.env`) keeps SQLite's default `synchronous`; for a test about durability or cross-process locking, where skipping the fsync would change what is measured. The shared setup (tests/setup/isolate-home.ts) sets the switch for the whole file and restores it afterwards. */
export function useRealFsync(): void {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[NO_FSYNC_ENV];
    delete process.env[NO_FSYNC_ENV];
  });
  afterEach(() => {
    if (prior === undefined) {
      delete process.env[NO_FSYNC_ENV];
    } else {
      process.env[NO_FSYNC_ENV] = prior;
    }
  });
}
