import { sep } from "node:path";

/** Case-folds a path for comparison on filesystems that ignore case. win32 only, matching anchors.ts's `FS_CASE_INSENSITIVE` and for the same reason: macOS is case-insensitive by default but supports case-sensitive APFS volumes, so folding there would trade a missed match for a false one. */
export function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Checks whether `child` is located inside `root` or equals it, handling filesystem roots (/ or C:\) correctly. Returns true if child equals root, or if child is a direct child or descendant of root. */
export function isInsideOrEqual(child: string, root: string): boolean {
  if (child === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}
