/** Type declarations for scripts/sync-arch-docs.mjs, so the guard tests can import the engine in-process under NodeNext without enabling allowJs. */
export interface SyncGit {
  ensureRepo(repoRoot: string): void;
  listComponents(repoRoot: string, patterns: string[], excludePatterns: string[]): string[];
  detectRenames(repoRoot: string): Map<string, { target: string; type: string }[]>;
}

export interface SyncOptions {
  mode: "check" | "write";
  format: "text" | "json";
  strictCurated: boolean;
  git?: SyncGit;
}

export interface SyncJsonPayload {
  status: "drift" | "ok";
  unmapped: string[];
  obsolete: string[];
  curated_at_risk: string[];
  uncategorized: string[];
}

export interface SyncResult {
  exitCode: 0 | 1 | 2;
  stderr: string[];
  changed: boolean;
  jsonPayload: SyncJsonPayload | null;
}

export function runSync(repoRoot: string, options: SyncOptions): SyncResult;

export function selfTest(): { pass: boolean; summary: string };
