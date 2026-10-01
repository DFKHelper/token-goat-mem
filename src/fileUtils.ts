/** Shared filesystem helpers: errno-to-message mapping for imports (ENOENT, EACCES, EISDIR), and the owner-only permissions mem applies to every file that holds fact rows -- the live store and each snapshot of it. */

import { chmodSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";

/** Permissions mem forces on its own home directory, database file, and backup snapshots on POSIX systems. Facts are exactly the class of data that must not be world-readable: project internals, decisions, and whatever personal detail survived capture-time secret screening (which targets credentials, not PII). Left to a default umask of 022 the directory would be 0755 and the database 0644 -- readable by every local account on a shared host -- so the mode is stated here rather than inherited. Windows is excluded deliberately: `chmod` there only toggles the read-only bit and would say nothing about who can read the file, while the profile ACL `~/.mem` inherits already restricts it to the owning user. */
export const MEM_HOME_MODE = 0o700;
export const MEM_DB_MODE = 0o600;

/** Tightens `path` to `mode`, or does nothing on Windows or if the chmod is refused. Best-effort by design: a database mem can open but cannot chmod (an unusual ownership or mount setup) is still a working database, and failing the whole CLI over a permission hardening step would trade a confidentiality improvement for an availability regression. */
export function restrictPermissions(path: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Intentionally silent: see the doc comment above.
  }
}

const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** A file size for a human (`1023 B`, `1.5 KiB`, `5.0 MiB`): binary units, one decimal past a kibibyte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit] ?? "TiB"}`;
}

/** Reads a file and maps filesystem errors to a user-facing error class. Used by both JSON and Markdown import modules to avoid duplication. */
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

/** Stats a file and maps filesystem errors to a user-facing error class. Used by JSON import to check file size before reading. */
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

/** Maps a filesystem error (ENOENT, EACCES, EISDIR, etc.) to a user-facing error message. Generic helper used by readFileWithErrorMapping and statFileWithErrorMapping. */
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
