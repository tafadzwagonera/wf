import { packageManagerScriptArgSeparator, type PackageManager } from './detect-repo-conventions';

export interface RunnerInvocation {
  script: string;
}

const npmBuiltInScripts = ['test', 'start', 'stop', 'restart'];

const toInvocation = (script: string | undefined): RunnerInvocation | null => script ? { script } : null;

export const formatRunnerInvocation = (packageManager: PackageManager, script: string, args?: string): string => {
  let runner: string;
  switch (packageManager) {
    case 'npm':
      runner = `npm run ${script}`;
      break;
    case 'yarn':
      runner = `yarn ${script}`;
      break;
    default: runner = `${packageManager} run ${script}`;
  }
  return args ? `${runner}${packageManagerScriptArgSeparator(packageManager)}${args}` : runner;
};

const parseNpmInvocation = (second: string | undefined, third: string | undefined): RunnerInvocation | null => {
  if (second === 'run') return toInvocation(third);
  return second && npmBuiltInScripts.includes(second) ? { script: second } : null;
};

const parseRunInvocation = (second: string | undefined, third: string | undefined): RunnerInvocation | null =>
  second === 'run' ? toInvocation(third) : null;

const parseYarnInvocation = (second: string | undefined, third: string | undefined): RunnerInvocation | null =>
  toInvocation(second === 'run' ? third : second);

const runnerParsers: Record<string, typeof parseNpmInvocation> = {
  npm: parseNpmInvocation,
  yarn: parseYarnInvocation,
  pnpm: parseRunInvocation,
  bun: parseRunInvocation,
};

export const parseRunnerInvocation = (command: string): RunnerInvocation | null => {
  const [runner, second, third] = command.trim().split(/\s+/);
  if (!runner) return null;
  if (runner === 'nr' || runner === 'npx') {
    return second ? { script: second } : null;
  }
  return runnerParsers[runner]?.(second, third) ?? null;
};
