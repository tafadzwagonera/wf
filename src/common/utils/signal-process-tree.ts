import type { ChildProcess } from 'child_process';

/**
 * Signals a spawned CLI's entire process group rather than just the child.
 *
 * The provider CLIs spawn their own subprocesses — test runners, linters, builds — and those
 * grandchildren are what actually hold the memory. Signalling only the direct child leaves
 * them running, so a killed stage can still leave a test runner and its worker pool resident
 * indefinitely. Spawn the child with `detached: true` so its pid doubles as the process-group
 * id, and the negated pid then reaches every descendant.
 *
 * The child is signalled directly afterwards too. The group signal already covers it, so this
 * is redundant on the happy path, but it keeps the `ChildProcess` exit bookkeeping accurate
 * and still terminates the child when the group signal cannot land — a failed spawn has no
 * pid, and a group that has already been reaped raises `ESRCH`.
 *
 * @param child - Spawned child process, group leader of its descendants
 * @param signal - Signal to deliver to the group and the child
 */
export const signalProcessTree = (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void => {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already reaped, or the pid never led a group; the direct signal below still applies.
    }
  }
  child.kill(signal);
};
