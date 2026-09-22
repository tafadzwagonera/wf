/**
 * Manual smoke test: issue:generate cross-repo git-hooks discovery
 *
 * Run: yarn test:manual test-issue-generate-cross-repo-git-hooks
 *
 * Verifies:
 *   1. The live issue:generate prompt includes repo conventions for the primary repo.
 *   2. The prompt renders git hook bullets for a real lefthook config.
 *   3. The prompt includes a full conventions section for the secondary repo using a different git-hooks tool,
 *      including a Git hooks entry naming that tool.
 *   4. The prompt includes a cross-repo delta when the secondary repo has no git hooks.
 *   5. The live command does not need a real AI provider because the manual smoke test patches the stage backends.
 */

import { NestFactory } from '@nestjs/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { createReporter, summarise } from './support/reporter';

const MOCK_TICKET = JSON.stringify({
  title: 'Hook Discovery',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Hook discovery smoke test.',
    '',
    '#### Technical Details',
    'None',
    '',
    '### Acceptance Criteria',
    '- None',
    '',
    '### Risks & Assumptions',
    '- None',
    '',
    '#### Out of Scope',
    '- None',
  ].join('\n'),
});

const { counts, pass, fail } = createReporter();

type AiMockHandles = {
  originalExecute: typeof AiService.prototype.execute;
  originalGenerateFromPrompt: typeof StageAgentService.prototype.generateFromPrompt;
};

type AiProto = { execute: typeof AiService.prototype.execute };
type StageAgentProto = { generateFromPrompt: typeof StageAgentService.prototype.generateFromPrompt };

function patchAiMocks(onCapture: (prompt: string) => void): AiMockHandles {
  const originalExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  (AiService.prototype as unknown as AiProto).execute = async (request: { prompt?: string }) => {
    onCapture(request.prompt ?? '');
    return { content: MOCK_TICKET };
  };
  (StageAgentService.prototype as unknown as StageAgentProto).generateFromPrompt = async (prompt: string) => {
    onCapture(prompt);
    return { content: MOCK_TICKET };
  };
  return { originalExecute, originalGenerateFromPrompt };
}

async function capturePrompt(command: IssueGenerateCommand, args: string[], repos: string[]): Promise<string> {
  let capturedPrompt = '';
  const handles = patchAiMocks(prompt => {
    capturedPrompt = prompt;
  });
  try {
    await command.run(args, { repos, silent: true });
  } finally {
    AiService.prototype.execute = handles.originalExecute;
    StageAgentService.prototype.generateFromPrompt = handles.originalGenerateFromPrompt;
  }
  return capturedPrompt;
}

function writeRepoBaseFiles(repoRoot: string): void {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: path.basename(repoRoot), version: '1.0.0' }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(path.join(repoRoot, 'ticket.md'), '# Source\n\nSmoke test source.\n', 'utf-8');
}

function writeLefthookConfig(repoRoot: string): void {
  fs.writeFileSync(
    path.join(repoRoot, 'lefthook.yml'),
    [
      'pre-commit:',
      '  commands:',
      '    lint:',
      '      run: yarn lint',
      '    typecheck:',
      '      run: yarn typecheck',
      '',
    ].join('\n'),
    'utf-8'
  );
}

function writeHuskyConfig(repoRoot: string): void {
  const huskyDir = path.join(repoRoot, '.husky');
  fs.mkdirSync(huskyDir, { recursive: true });
  fs.writeFileSync(path.join(huskyDir, 'pre-commit'), '#!/usr/bin/env sh\nyarn lint\n', 'utf-8');
}

function createRepo(repoRoot: string, gitHookTool: 'lefthook' | 'husky' | 'none'): void {
  writeRepoBaseFiles(repoRoot);
  if (gitHookTool === 'lefthook') {
    writeLefthookConfig(repoRoot);
    return;
  }
  if (gitHookTool === 'husky') {
    writeHuskyConfig(repoRoot);
  }
}

function checkPrimaryRepoHooks(prompt: string): void {
  if (prompt.includes('Git hooks (lefthook):')) {
    pass('live prompt includes the primary repo git-hooks section');
  } else {
    fail('live prompt is missing the primary repo git-hooks section', prompt.slice(0, 800));
  }
  if (prompt.includes('  - pre-commit: yarn lint, yarn typecheck')) {
    pass('live prompt renders nested hook bullets for lefthook');
  } else {
    fail('live prompt does not render nested lefthook bullets', prompt.slice(0, 800));
  }
}

function checkSecondaryHuskySection(prompt: string): void {
  if (prompt.includes('Repository conventions (secondary-husky):')) {
    pass('live prompt includes the full conventions section for the secondary repo using a different git-hooks tool');
  } else {
    fail('live prompt is missing the full conventions section for secondary-husky', prompt.slice(0, 800));
  }
  if (prompt.includes('Git hooks (husky):')) {
    pass('live prompt surfaces the husky git-hooks tool inside the secondary-husky conventions section');
  } else {
    fail('live prompt is missing the husky git-hooks entry in secondary-husky conventions', prompt.slice(0, 800));
  }
}

function checkMissingHooksAssertion(prompt: string): void {
  if (prompt.includes('secondary-empty has no git hooks (primary uses lefthook)')) {
    pass('live prompt includes the cross-repo delta when the secondary repo has no hooks');
  } else {
    fail('live prompt is missing the cross-repo no-hooks delta', prompt.slice(0, 800));
  }
}

async function runDifferingToolsScenario(
  command: IssueGenerateCommand,
  primaryRepo: string,
  secondaryRepoWithDifferentTool: string,
): Promise<void> {
  const ticketPath = path.join(primaryRepo, 'ticket.md');
  const prompt = await capturePrompt(
    command,
    [ticketPath],
    [primaryRepo, secondaryRepoWithDifferentTool],
  );
  checkPrimaryRepoHooks(prompt);
  checkSecondaryHuskySection(prompt);
}

async function runMissingHooksScenario(
  command: IssueGenerateCommand,
  primaryRepo: string,
  secondaryRepoWithoutHooks: string,
): Promise<void> {
  const ticketPath = path.join(primaryRepo, 'ticket.md');
  const prompt = await capturePrompt(
    command,
    [ticketPath],
    [primaryRepo, secondaryRepoWithoutHooks],
  );
  checkMissingHooksAssertion(prompt);
}

async function runAllScenarios(
  command: IssueGenerateCommand,
  primaryRepo: string,
  secondaryRepoWithDifferentTool: string,
  secondaryRepoWithoutHooks: string,
): Promise<void> {
  await runDifferingToolsScenario(command, primaryRepo, secondaryRepoWithDifferentTool);
  await runMissingHooksScenario(command, primaryRepo, secondaryRepoWithoutHooks);
}

type RepoSetup = {
  primaryRepo: string;
  secondaryRepoWithDifferentTool: string;
  secondaryRepoWithoutHooks: string;
};

function setupRepos(tempRoot: string): RepoSetup {
  const primaryRepo = path.join(tempRoot, 'primary-repo');
  const secondaryRepoWithDifferentTool = path.join(tempRoot, 'secondary-husky');
  const secondaryRepoWithoutHooks = path.join(tempRoot, 'secondary-empty');
  createRepo(primaryRepo, 'lefthook');
  createRepo(secondaryRepoWithDifferentTool, 'husky');
  createRepo(secondaryRepoWithoutHooks, 'none');
  return { primaryRepo, secondaryRepoWithDifferentTool, secondaryRepoWithoutHooks };
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Manual Test: issue:generate cross-repo git-hooks discovery\n'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-cross-repo-git-hooks-'));
  const { primaryRepo, secondaryRepoWithDifferentTool, secondaryRepoWithoutHooks } = setupRepos(tempRoot);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const command = app.get(IssueGenerateCommand);
    await runAllScenarios(command, primaryRepo, secondaryRepoWithDifferentTool, secondaryRepoWithoutHooks);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
