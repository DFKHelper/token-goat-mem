/** Every `TOKEN_GOAT_MEM_*` variable the shared setup sets to a temp or fixed value for the whole file; `tests/setup/isolate-home.ts` owns the values. */
export const PINNED_ENV = [
  "TOKEN_GOAT_MEM_HOME",
  "TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS",
  "TOKEN_GOAT_MEM_BACKUP_DIR",
  "TOKEN_GOAT_MEM_WIRING_HOME",
  "TOKEN_GOAT_MEM_TEST_UNSAFE_NO_FSYNC",
] as const;

/** Every other `TOKEN_GOAT_MEM_*` variable `src/` reads: the shared setup deletes each before a test file runs and restores it afterwards, so a variable exported in the developer's shell or the CI runner cannot change what in-process `runCli` does. A test that needs one sets it itself. */
export const SCRUBBED_ENV = [
  "TOKEN_GOAT_MEM_EMBED_URL",
  "TOKEN_GOAT_MEM_EMBED_MODEL",
  "TOKEN_GOAT_MEM_EMBED_API_KEY",
  "TOKEN_GOAT_MEM_DREAM_URL",
  "TOKEN_GOAT_MEM_DREAM_MODEL",
  "TOKEN_GOAT_MEM_DREAM_API_KEY",
  "TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS",
  "TOKEN_GOAT_MEM_PROJECT_IDENTITY",
] as const;
