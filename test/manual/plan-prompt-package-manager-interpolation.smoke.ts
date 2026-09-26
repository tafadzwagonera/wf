/**
 * Manual smoke test: AiService.generatePlan embeds the detected package manager
 * (and the correct conditional " -- " separator) in the plan prompt JSON schema example.
 *
 * Run: nr test:manual plan-prompt-package-manager-interpolation.smoke
 *
 * Verifies:
 *   1. No conventions → defaults to npm → prompt contains "npm test:manual -- test-auth-guard"
 *   2. conventions.packageManager = 'yarn' → prompt contains "yarn test:manual test-auth-guard" (no " -- ")
 *   3. "yarn test:manual" absent from the npm-default prompt
 */

import chalk from 'chalk';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const lacks = (text: string, fragment: string): boolean => !text.includes(fragment);

const check = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const VALID_PLAN_JSON = JSON.stringify({
  action: 'fix',
  summary: 'Fix auth guard behaviour after rename.',
  steps: ['Rename AuthGuard to SharedAuthGuard'],
  estimatedComplexity: 'low',
  affectedFiles: [],
  affectedRepositories: ['repo-a'],
});

const YARN_CONVENTIONS = {
  language: 'typescript',
  namingPattern: 'kebab-case',
  importStyle: 'esm',
  folderStructure: [],
  keyDependencies: [],
  errorHandlingPaths: [],
  gitHooks: [],
  packageManager: 'yarn',
};

const makeLogger = () => ({ info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, log: () => {} });

const makeConfigStub = () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue });

function makeCapturingAdapter() {
  let capturedPrompt = '';
  return {
    execute: async (req: any) => {
      capturedPrompt = req.prompt as string;
      return { content: VALID_PLAN_JSON, provider: 'openai', model: 'gpt-4o' };
    },
    executeWithHistory: async () => ({ content: '' }),
    getCaptured: () => capturedPrompt,
  };
}

const verificationExcerpt = (prompt: string): string => {
  const start = prompt.indexOf('"verification"');
  return prompt.slice(start, start + 200);
};

async function checkNpmDefault(): Promise<void> {
  const adapter = makeCapturingAdapter();
  const service = new AiService(makeLogger() as any, adapter as any, makeConfigStub() as any);
  await service.generatePlan('fix', '# T-1 Fix auth guard', { affectedRepositories: ['repo-a'] });
  const prompt = adapter.getCaptured();
  check(
    'no conventions → prompt contains "npm test:manual -- test-auth-guard"',
    prompt.includes('"run":"npm test:manual -- test-auth-guard"'),
    verificationExcerpt(prompt),
  );
  check('"yarn test:manual" absent from npm-default prompt', lacks(prompt, '"run":"yarn test:manual'), 'unexpected yarn reference found');
}

async function checkYarnConventions(): Promise<void> {
  const adapter = makeCapturingAdapter();
  const service = new AiService(makeLogger() as any, adapter as any, makeConfigStub() as any);
  await service.generatePlan('fix', '# T-2 Fix auth guard', {
    affectedRepositories: ['repo-a'],
    conventions: YARN_CONVENTIONS as any,
  });
  const prompt = adapter.getCaptured();
  check(
    'yarn conventions → prompt contains "yarn test:manual test-auth-guard" (no " -- ")',
    prompt.includes('"run":"yarn test:manual test-auth-guard"'),
    verificationExcerpt(prompt),
  );
  check('"yarn test:manual -- " absent from yarn-conventions prompt', lacks(prompt, '"run":"yarn test:manual -- '), 'unexpected "-- " found in yarn prompt');
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Plan prompt package-manager interpolation smoke test\n'));

  console.log(chalk.bold('Default package manager'));
  await checkNpmDefault();

  console.log(chalk.bold('\nYarn conventions'));
  await checkYarnConventions();

  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
