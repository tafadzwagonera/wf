/**
 * Manual Test: wf.config.js using module.exports in a "type": "module" project can read process.env
 *
 * Run: nr test:manual esm-config-reads-process-env.smoke
 * Precondition: yarn build
 *
 * Verifies:
 *   1. module.exports .js config reading process.env in a type:module project: exit 0 and "is installed and working!"
 *   2. The ai entry is read from the env value: output has default-provider=openai
 *   3. No "process is not defined" or "Failed to evaluate config file" error
 *   4. Regression guard: the same config as wf.config.js in a CommonJS project also loads
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const distMain = path.join(__dirname, '../../dist/main.js');
const configSource = [
  'module.exports = {',
  "  ai: [{ provider: 'openai', apiKey: process.env.WF_SMOKE_OPENAI_KEY, model: 'gpt-5.4', default: true }],",
  '};',
  '',
].join('\n');

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

function runCowsay(projectDir: string): { exitCode: number | null; output: string } {
  const result = spawnSync('node', [distMain, 'issue:cowsay'], {
    cwd: projectDir,
    env: { PATH: process.env.PATH ?? '', HOME: path.join(projectDir, 'home'), WF_SMOKE_OPENAI_KEY: 'smoke-key' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function createProject(packageType: 'module' | 'commonjs', configFile: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-config-env-'));
  fs.mkdirSync(path.join(projectDir, 'home'));
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ type: packageType }));
  fs.writeFileSync(path.join(projectDir, configFile), configSource);
  return projectDir;
}

function checkModuleProject(): void {
  const projectDir = createProject('module', 'wf.config.js');
  try {
    const run = runCowsay(projectDir);
    const tail = run.output.slice(-400);
    check(run.exitCode === 0 && run.output.includes('is installed and working!'),
      'module.exports .js config reading process.env loads in a type:module project', `exit ${run.exitCode}: ${tail}`);
    check(run.output.includes('default-provider=openai'), 'ai entry from the config reaches the banner', tail);
    check(!run.output.includes('process is not defined') && !run.output.includes('Failed to evaluate config file'),
      'no process-not-defined error', tail);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function checkMjsInCommonJsProject(): void {
  const projectDir = createProject('commonjs', 'wf.config.js');
  try {
    const run = runCowsay(projectDir);
    check(run.exitCode === 0 && run.output.includes('default-provider=openai'),
      'regression guard: wf.config.js in a CommonJS project loads', `exit ${run.exitCode}: ${run.output.slice(-400)}`);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('\n ESM config reads process.env\n');
  checkModuleProject();
  checkMjsInCommonJsProject();
  summarise(counts);
}

main();
