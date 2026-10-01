/** Drives one `mem` invocation through the real `run()` entry point (the one src/main.ts calls) and captures what it wrote, for every in-process end-to-end test file. Shared rather than duplicated, and a plain module rather than a `.test.ts` one so importing it does not re-register the importing file's tests. The out-of-process equivalent, for the shipped bundle, lives in tests/bundle/. */
import { vi } from "vitest";

import { run } from "../../src/cli.js";

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/** Runs one CLI invocation, capturing everything written to stdout/stderr instead of letting it hit the real streams, and returning the resulting `process.exitCode`. Resets `process.exitCode` to `undefined` immediately after each call so a command that intentionally exercises the error path (exit code 1) never leaks into the exit code of the vitest process itself. */
export async function runCli(args: readonly string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    stdout += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderr += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });

  process.exitCode = undefined;
  try {
    await run(["node", "mem", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout, stderr, exitCode };
}

/** Extracts the fact id from the `remember` command's success line. The noun phrase is `<kind> fact` for every kind except `fact` itself, which collapses to one word rather than printing "fact fact" -- so the kind portion has to be optional here, not a required token. */
export function extractRememberedId(result: CliResult): string {
  return extractCapturedId(result, /remembered (?:\S+ )?fact (\S+)/u);
}

/** Extracts the pending fact id from the `suggest` command's success line (`suggested <kind> fact <id> (pending)`); same noun-phrase rule as `extractRememberedId`. */
export function extractSuggestedId(result: CliResult): string {
  return extractCapturedId(result, /suggested (?:\S+ )?fact (\S+) \(pending\)/u);
}

function extractCapturedId(result: CliResult, pattern: RegExp): string {
  const match = pattern.exec(result.stdout);
  if (match?.[1] === undefined) {
    throw new Error(`could not extract fact id from stdout: ${JSON.stringify(result.stdout)}`);
  }
  return match[1];
}
