/**
 * Fails any unit test that shells out to the test runner.
 *
 * A spec reached the real pre-review verification path and ran `yarn test`, which re-entered
 * this suite; each nested run spawned its own workers, which each ran `yarn test` again. The
 * host reached 461 node processes holding 74GB on 18GB of RAM and had to be power-cycled
 * twice. Mocking the offending module fixes that one case — this makes the whole class of
 * mistake impossible.
 *
 * Deliberately narrow. An earlier attempt blocked *every* child process, but a global
 * `child_process` mock also replaces the module for third-party packages, which hangs specs
 * that never spawn anything themselves. Commands are therefore inspected and only
 * test-runner invocations are refused; everything else reaches the real implementation.
 *
 * This does not stop a spec from shelling out in general — several still do, which is worth
 * cleaning up separately. It stops the one pattern that can take the machine down.
 */

const RECURSIVE_TEST_COMMAND = /(^|[;&|\s])(jest|vitest)\b|\b(yarn|npm|pnpm|bun)\s+(run\s+)?test(:[\w-]+)?\b/;

const GUARDED_METHODS = ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync'];

/** Renders a command plus its argument array, so `execFile('yarn', ['test'])` is matched too. */
const renderCommand = (args: unknown[]): string =>
  [args[0], Array.isArray(args[1]) ? args[1].join(' ') : ''].filter(Boolean).join(' ');

const guardMethod = (
  real: (...args: unknown[]) => unknown,
  specifier: string,
  method: string
) => (...args: unknown[]): unknown => {
  const command = renderCommand(args);
  if (typeof args[0] === 'string' && RECURSIVE_TEST_COMMAND.test(command)) {
    throw new Error(
      `Blocked recursive test run: ${specifier}.${method}("${command}") re-enters the test suite. `
      + 'Mock the module that spawns it — nested runs fork until the host runs out of memory.'
    );
  }
  return real(...args);
};

const mockGuardModule = (specifier: string): Record<string, unknown> => {
  const actual = jest.requireActual<Record<string, unknown>>(specifier);
  const guarded: Record<string, unknown> = { ...actual };
  for (const method of GUARDED_METHODS) {
    guarded[method] = guardMethod(actual[method] as (...args: unknown[]) => unknown, specifier, method);
  }
  return guarded;
};

jest.mock('child_process', () => mockGuardModule('child_process'));
jest.mock('node:child_process', () => mockGuardModule('node:child_process'));

export {};
