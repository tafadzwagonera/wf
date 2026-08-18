import { execSync } from 'node:child_process';
import { execSync as execSyncCjs } from 'child_process';

/**
 * Self-test for `test/setup/no-recursive-test-runs.ts`.
 *
 * The guard is what stands between a mis-mocked spec and the fork bomb that previously
 * required two power-button resets, so it needs a test of its own — a guard that silently
 * stopped matching would be indistinguishable from no guard at all.
 */
describe('recursive test run guard', () => {
  it.each([
    ['yarn test'],
    ['yarn test:ci'],
    ['npm test'],
    ['npm run test'],
    ['pnpm test'],
    ['jest'],
    ['npx jest --runInBand'],
    ['cd repo && yarn test -- src/foo.spec.ts'],
  ])('refuses to shell out to %s', command => {
    expect(() => execSync(command)).toThrow(/Blocked recursive test run/);
  });

  it('guards the bare child_process specifier as well as node:child_process', () => {
    expect(() => execSyncCjs('yarn test')).toThrow(/Blocked recursive test run/);
  });

  it('still allows commands that do not re-enter the test runner', () => {
    expect(execSync('echo not-a-test-run').toString()).toContain('not-a-test-run');
  });

  it('does not mistake an unrelated command that merely contains the word test', () => {
    expect(execSync('echo latest').toString()).toContain('latest');
  });
});
