/**
 * Manual Test: SEA binary loads wf.config.ts through its bundled jiti
 *
 * Run: nr test:manual sea-binary-ts-config-bundled-jiti.smoke
 * Precondition: yarn build:sea
 *
 * Verifies:
 *   1. Control: with no config file the banner shows the built-in default model
 *   2. A wf.config.ts that imports ./helper loads: cowsay exits 0 and reports the helper's model
 *      as default-model (the file was evaluated and the relative import resolved)
 *   3. No "install jiti" error appears, with no jiti or node_modules in the project
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertSeaBinaryBuilt, cleanPath, createTempDir, removeDir, runSeaBinary, seaBinaryPath,
} from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const helperModel = 'claude-sonnet-4-6';

const runIn = (projectDir: string) => runSeaBinary(seaBinaryPath, ['issue:cowsay'], {
  cwd: projectDir,
  env: { PATH: cleanPath, HOME: projectDir },
});

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

function checkControlWithoutConfig(projectDir: string): void {
  const control = runIn(projectDir);
  check(control.exitCode === 0 && !control.output.includes(`default-model=${helperModel}`),
    'control: no config file does not report the helper model', control.output.slice(-300));
}

function writeConfigImportingHelper(projectDir: string): void {
  fs.writeFileSync(path.join(projectDir, 'helper.ts'), `export const model = '${helperModel}';\n`);
  fs.writeFileSync(
    path.join(projectDir, 'wf.config.ts'),
    [
      "import { model } from './helper';",
      'export default {',
      "  ai: [{ provider: 'anthropic', apiKey: 'test-key', model, default: true }],",
      '};',
      '',
    ].join('\n'),
  );
}

function checkConfigIsEvaluated(projectDir: string): void {
  const loaded = runIn(projectDir);
  const tail = loaded.output.slice(-400);
  check(loaded.exitCode === 0 && loaded.output.includes(`default-model=${helperModel}`),
    'wf.config.ts with a relative import is evaluated and its model reaches the banner', `exit ${loaded.exitCode}: ${tail}`);
  check(!/install.*jiti/i.test(loaded.output) && !loaded.output.includes('Bundled jiti is not registered'),
    'no jiti-missing error', tail);
}

function main(): void {
  assertSeaBinaryBuilt();
  console.log('\n SEA binary: wf.config.ts via bundled jiti\n');
  const projectDir = createTempDir('sea-ts-config-');
  try {
    checkControlWithoutConfig(projectDir);
    writeConfigImportingHelper(projectDir);
    checkConfigIsEvaluated(projectDir);
  } finally {
    removeDir(projectDir);
  }
  summarise(counts);
}

main();
