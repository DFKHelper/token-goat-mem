/**
 * Case-folds a path for comparison on filesystems that ignore case.
 *
 * win32 only, matching anchors.ts's `FS_CASE_INSENSITIVE` and for the same reason: macOS is
 * case-insensitive by default but supports case-sensitive APFS volumes, so folding there would
 * trade a missed match for a false one.
 */
export function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
