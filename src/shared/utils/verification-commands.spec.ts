import { formatRunnerInvocation, parseRunnerInvocation } from './verification-commands';
import type { PackageManager } from './detect-repo-conventions';

describe('formatRunnerInvocation', () => {
  const packageManagers: PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];

  it('loads the runner-command module exports', () => {
    expect(formatRunnerInvocation).toEqual(expect.any(Function));
    expect(parseRunnerInvocation).toEqual(expect.any(Function));
  });

  it.each([
    ['npm', 'test', undefined, 'npm run test'],
    ['npm', 'test:manual', 'auth.spec.ts', 'npm run test:manual -- auth.spec.ts'],
    ['yarn', 'test', undefined, 'yarn test'],
    ['yarn', 'test:manual', 'auth.spec.ts', 'yarn test:manual auth.spec.ts'],
    ['pnpm', 'test', undefined, 'pnpm run test'],
    ['pnpm', 'test:manual', 'auth.spec.ts', 'pnpm run test:manual auth.spec.ts'],
    ['bun', 'test', undefined, 'bun run test'],
    ['bun', 'test:manual', 'auth.spec.ts', 'bun run test:manual auth.spec.ts'],
  ] as const)('formats %s %s', (packageManager, script, args, expected) => {
    expect(formatRunnerInvocation(packageManager, script, args)).toBe(expected);
  });

  it.each([
    ['pnpm run test', 'test'],
    ['npm test', 'test'],
    ['yarn test', 'test'],
    ['yarn run test', 'test'],
    ['bun run test', 'test'],
    ['nr test:manual x', 'test:manual'],
    ['npx test x', 'test'],
  ])('parses %s', (command, script) => {
    expect(parseRunnerInvocation(command)).toEqual({ script });
  });

  it.each(['npm lint', 'jest x', '', 'npm', 'pnpm'])('rejects %s', command => {
    expect(parseRunnerInvocation(command)).toBeNull();
  });

  it.each(packageManagers)('round-trips formatted %s commands through parsing', packageManager => {
    for (const script of ['test', 'test:manual']) {
      expect(parseRunnerInvocation(formatRunnerInvocation(packageManager, script, 'x'))?.script).toBe(script);
    }
  });
});
