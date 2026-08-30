#!/usr/bin/env node
/**
 * Package executable. Thin shim over {@link run} in `cli.ts`.
 *
 * `run` sets `process.exitCode` rather than calling `process.exit()`, so we let the event loop drain
 * naturally -- this guarantees buffered stdout is flushed before the process ends, which a hard
 * `exit()` can truncate on Windows pipes.
 */

import { run } from "./cli.js";

/**
 * Exit quietly when the reader of our stdout/stderr goes away.
 *
 * `mem recall | head -1` or `mem recall | grep -q pnpm` closes the pipe as soon as the reader has
 * what it wants. The next write then fails with EPIPE, and because nothing listens for `error` on
 * the stream, node promotes it to an unhandled `error` event and the process dies with a stack
 * trace and exit code 1 -- for a pipeline that did exactly what the user asked. Terminating early
 * is the reader's prerogative, so it is not an error condition for the writer.
 *
 * `process.exit()` here does not contradict the note above about letting the event loop drain: that
 * exists so buffered output reaches a pipe before the process ends, and EPIPE means the pipe is
 * already gone. There is nothing left to flush and no one to flush it to.
 *
 * Installed here rather than in `run()` because it mutates process-global state, and `run()` is
 * called in-process by the test suite.
 */
function exitQuietlyOnClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

exitQuietlyOnClosedPipe(process.stdout);
exitQuietlyOnClosedPipe(process.stderr);

void run();
