import * as path from 'node:path';

/**
 * Fails any unit test that shells out to the test runner, or that runs a subprocess inside
 * the working tree under test.
 *
 * Two separate hazards, one interception point.
 *
 * Recursion: a spec reached the real pre-review verification path and ran `yarn run test`,
 * which re-entered this suite; each nested run spawned workers that ran it again, until the
 * host held 461 node processes on 18GB of RAM and had to be power-cycled twice.
 *
 * Working-tree writes: an audit of one suite run recorded 79 real subprocesses, six of them
 * executing `git` with `cwd` set to the actual repository. Those six were read-only, so
 * nothing was damaged — but `verification-report.ts` executes arbitrary command strings taken
 * from fixtures, `install-dependencies.ts` runs a real package install, and `GitService` can
 * check out and reset. Only the choice of fixture kept uncommitted work safe. Confining `cwd`
 * removes that coincidence: a test may shell out, but never inside the repo it is testing.
 *
 * Deliberately narrow on the command axis. An earlier attempt blocked *every* child process,
 * but a global `child_process` mock also replaces the module for third-party packages, which
 * hung specs that spawn nothing themselves. Commands outside the tree still reach the real
 * implementation.
 */

const RECURSIVE_TEST_COMMAND = /(^|[;&|\s])(jest|vitest)\b|\b(yarn|npm|pnpm|bun)\s+(run\s+)?test(:[\w-]+)?\b/;

const guardedMethods = ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync'];

// Captured before any spec runs, while cwd is still the project root Jest was invoked from.
const PROJECT_ROOT = process.cwd();

/** Renders a command plus its argument array, so `execFile('yarn', ['test'])` is matched too. */
const renderCommand = (args: unknown[]): string =>
  [args[0], Array.isArray(args[1]) ? args[1].join(' ') : ''].filter(Boolean).join(' ');

/** Resolves the cwd a call would run in; an omitted `cwd` inherits the project root. */
const resolveCwd = (args: unknown[]): string => {
  const options = args.find(
    (arg): arg is { cwd?: unknown } => Boolean(arg) && typeof arg === 'object' && 'cwd' in (arg as object)
  );
  const cwd = options?.cwd;
  return typeof cwd === 'string' ? path.resolve(cwd) : PROJECT_ROOT;
};

const isInsideProjectRoot = (candidate: string): boolean =>
  candidate === PROJECT_ROOT || candidate.startsWith(`${PROJECT_ROOT}${path.sep}`);

/** Returns the reason a call must be refused, or undefined when it may proceed. */
const refusalReason = (args: unknown[], where: string): string | undefined => {
  const command = renderCommand(args);
  if (typeof args[0] === 'string' && RECURSIVE_TEST_COMMAND.test(command)) {
    return `Blocked recursive test run: ${where}("${command}") re-enters the test suite. `
      + 'Mock the module that spawns it — nested runs fork until the host runs out of memory.';
  }
  const cwd = resolveCwd(args);
  if (isInsideProjectRoot(cwd)) {
    return `Blocked subprocess inside the working tree: ${where}("${command}") would run in ${cwd}. `
      + 'Mock the module that spawns it, or point the call at a temporary directory — a test must '
      + 'never execute commands in the repository it is testing.';
  }
  return undefined;
};

const guardMethod = (
  real: (...args: unknown[]) => unknown,
  specifier: string,
  method: string
) => (...args: unknown[]): unknown => {
  const reason = refusalReason(args, `${specifier}.${method}`);
  if (reason) throw new Error(reason);
  return real(...args);
};

const mockGuardModule = (specifier: string): Record<string, unknown> => {
  const actual = jest.requireActual<Record<string, unknown>>(specifier);
  const guarded: Record<string, unknown> = { ...actual };
  for (const method of guardedMethods) {
    guarded[method] = guardMethod(actual[method] as (...args: unknown[]) => unknown, specifier, method);
  }
  return guarded;
};

jest.mock('child_process', () => mockGuardModule('child_process'));
jest.mock('node:child_process', () => mockGuardModule('node:child_process'));

export {};
