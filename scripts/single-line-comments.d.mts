/** Type declarations for scripts/single-line-comments.mjs, so the guard tests can import the engine in-process under NodeNext without enabling allowJs. */
export interface CommentCheckOptions {
  write?: boolean;
  root?: string;
  files?: string[];
}

export interface CommentCheckResult {
  exitCode: 0 | 1;
  output: string[];
}

export function runCommentCheck(options?: CommentCheckOptions): CommentCheckResult;

export function runSelfTest(): { pass: boolean; failures: string[]; summary: string };

export function readIndexPaths(index: Buffer): string[] | undefined;

export function trackedSources(root: string): string[];
