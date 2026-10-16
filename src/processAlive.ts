/** Whether a process with `pid` exists: signal 0 delivers nothing and fails with ESRCH for a pid no process holds, while EPERM means it exists under another user. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
