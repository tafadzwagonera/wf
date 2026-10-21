import { execSync } from 'node:child_process';
import { execSync as execSyncCjs } from 'child_process';
import * as os from 'node:os';

/**
 * Self-test for `test/setup/no-real-repo-subprocesses.ts`.
 *
 * The guard is what stands between a mis-mocked spec and either the fork bomb that previously
 * required two power-button resets, or a command executing in the developer's working tree.
 * A guard that silently stopped matching would be indistinguishable from no guard at all.
 */
const OUTSIDE_TREE = os.tmpdir();

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
    expect(() => execSync(command, { cwd: OUTSIDE_TREE })).toThrow(/Blocked recursive test run/);
  });

  it('guards the bare child_process specifier as well as node:child_process', () => {
    expect(() => execSyncCjs('yarn test', { cwd: OUTSIDE_TREE })).toThrow(/Blocked recursive test run/);
  });
});

describe('working tree guard', () => {
  it('refuses a subprocess whose cwd is the repository under test', () => {
    expect(() => execSync('git status', { cwd: process.cwd() })).toThrow(/Blocked subprocess inside the working tree/);
  });

  it('refuses a subprocess nested anywhere beneath the repository', () => {
    expect(() => execSync('git status', { cwd: `${process.cwd()}/src` }))
      .toThrow(/Blocked subprocess inside the working tree/);
  });

  it('refuses a subprocess that inherits cwd, since that is the repository', () => {
    expect(() => execSync('git status')).toThrow(/Blocked subprocess inside the working tree/);
  });

  it('names the offending directory so the fix is obvious', () => {
    expect(() => execSync('git status')).toThrow(new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('allows a subprocess in a directory outside the tree', () => {
    expect(execSync('echo outside-the-tree', { cwd: OUTSIDE_TREE }).toString()).toContain('outside-the-tree');
  });

  it('does not mistake an unrelated command that merely contains the word test', () => {
    expect(execSync('echo latest', { cwd: OUTSIDE_TREE }).toString()).toContain('latest');
  });
});
