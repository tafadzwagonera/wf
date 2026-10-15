import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter } from './reporter';

const DIST_MAIN = path.join(__dirname, '../../../dist/main.js');

export const ANTHROPIC_MARKER = 'Anthropic Claude';
export const GOOGLE_MARKER = 'Google Gemini';
export const OPENAI_MARKER = 'default-provider=openai';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const reporter = createReporter();

export const runCli = (args: string, cwd: string, env: NodeJS.ProcessEnv): CliResult => {
  const result = spawnSync('node', [DIST_MAIN, ...args.split(' ')], { encoding: 'utf-8', cwd, env, timeout: 15_000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export const writeProviderConfig = (dir: string, provider: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'wf.config.js'),
    `module.exports = { ai: [{ provider: '${provider}', model: 'x', apiKey: 'k' }] };\n`
  );
};

export const baseEnv = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
};

export const homeEnv = (fakeHome: string, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  baseEnv({ HOME: fakeHome, USERPROFILE: fakeHome, ...overrides });

export const check = (passed: boolean, label: string, detail = ''): void => {
  if (passed) {
    reporter.pass(label);
  } else {
    reporter.fail(label, detail.slice(0, 800));
  }
};

export const assertLoaded = (result: CliResult, label: string, marker: string): void => {
  const detail = `${result.stdout}${result.stderr}`;
  check(result.exitCode === 0, `${label}: exits 0`, detail);
  check(result.stdout.includes(marker), `${label}: stdout has ${marker}`, detail);
  check(!result.stderr.includes('not found'), `${label}: stderr has no not-found error`, detail);
};

export const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;
