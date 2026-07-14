/**
 * Shared filesystem error handling for imports. Maps errno exceptions
 * (ENOENT, EACCES, EISDIR) to user-facing error messages.
 */

import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";

/**
 * Reads a file and maps filesystem errors to a user-facing error class.
 * Used by both JSON and Markdown import modules to avoid duplication.
 */
export function readFileWithErrorMapping<E extends Error>(
  filePath: string,
  ErrorClass: new (message: string) => E
): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw mapFileError(filePath, error, ErrorClass);
  }
}

/**
 * Stats a file and maps filesystem errors to a user-facing error class.
 * Used by JSON import to check file size before reading.
 */
export function statFileWithErrorMapping<E extends Error>(
  filePath: string,
  ErrorClass: new (message: string) => E
): Stats {
  try {
    return statSync(filePath);
  } catch (error) {
    throw mapFileError(filePath, error, ErrorClass);
  }
}

/**
 * Maps a filesystem error (ENOENT, EACCES, EISDIR, etc.) to a user-facing error message.
 * Generic helper used by readFileWithErrorMapping and statFileWithErrorMapping.
 */
function mapFileError<E extends Error>(
  filePath: string,
  error: unknown,
  ErrorClass: new (message: string) => E
): E {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new ErrorClass(`file not found: ${filePath}`);
  }
  if (code === "EACCES") {
    return new ErrorClass(`permission denied reading file: ${filePath}`);
  }
  if (code === "EISDIR") {
    return new ErrorClass(`is a directory, not a file: ${filePath}`);
  }
  return new ErrorClass(`cannot read file: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
}
