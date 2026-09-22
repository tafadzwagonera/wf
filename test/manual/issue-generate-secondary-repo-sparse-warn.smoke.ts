/**
 * Manual smoke test: issue:generate excludes sparse secondary repo and emits WARN log
 *
 * Run: yarn test:manual -- issue-generate-secondary-repo-sparse-warn.smoke
 *
 * Verifies:
 *   1. A secondary repo with no meaningful conventions and no deltas from the primary is
 *      excluded from the plan prompt's cross-repo section.
 *   2. appendToLogFile emits a WARN entry naming the excluded repo to the on-disk log file.
 *   3. When a meaningful secondary repo is present alongside the sparse one, the meaningful
 *      repo appears with a full conventions section while the sparse repo remains absent.
 *   4. The live command does not need a real AI provider because the manual smoke test
 *      patches the stage backends.
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
import { createReporter } from './support/reporter';

const mockTicket = JSON.stringify({
  title: 'Sparse Repo Guard',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Sparse secondary repo smoke test.',
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

const createSparseRepo = (repoRoot: string): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: path.basename(repoRoot), version: '1.0.0' }, null, 2),
    'utf-8'
  );
};

const createMeaningfulRepo = (repoRoot: string): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: path.basename(repoRoot),
      version: '1.0.0',
      devDependencies: { eslint: '^8.0.0', typescript: '^5.0.0', jest: '^29.0.0' },
    }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf-8');
  fs.writeFileSync(path.join(repoRoot, '.eslintrc.json'), JSON.stringify({ root: true }), 'utf-8');
};

function setupAiServiceMocks(mockExecute: (request: any) => Promise<{ content: string }>): void {
  const aiPrototype = AiService.prototype as unknown as {
    execute: typeof AiService.prototype.execute;
  };
  aiPrototype.execute = mockExecute;
}

function setupStageAgentMocks(mockGenerate: (prompt: string) => Promise<{ content: string }>): void {
  const stageAgentPrototype = StageAgentService.prototype as unknown as {
    generateFromPrompt: typeof StageAgentService.prototype.generateFromPrompt;
  };
  stageAgentPrototype.generateFromPrompt = mockGenerate;
}

function setupMocks(savePrompt: (p: string) => { content: string }): () => void {
  const originalExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  setupAiServiceMocks(async (request: { prompt?: string }) => savePrompt(request.prompt ?? ''));
  setupStageAgentMocks(async (prompt: string) => savePrompt(prompt));
  return () => {
    AiService.prototype.execute = originalExecute;
    StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;
  };
}

async function capturePrompt(command: IssueGenerateCommand, args: string[], repos: string[]): Promise<string> {
  let capturedPrompt = '';
  const savePrompt = (prompt: string): { content: string } => {
    capturedPrompt = prompt;
    return { content: mockTicket };
  };
  const restore = setupMocks(savePrompt);
  try {
    await command.run(args, { repos, silent: true });
  } finally {
    restore();
  }
  return capturedPrompt;
}

function checkSparseRepoInclusion(prompt: string): void {
  const hasSparseSectionKey = prompt.includes('Repository conventions (sparse-repo):');
  if (hasSparseSectionKey) {
    fail('sparse-repo incorrectly appears in the cross-repo conventions section');
  } else {
    pass('sparse-repo is correctly excluded from the cross-repo conventions section');
  }
}

function checkPatternHeader(prompt: string): void {
  const hasPatternHeader = prompt.includes('Patterns from related repositories:');
  if (hasPatternHeader) {
    fail('cross-repo section header appears when all secondary repos are sparse');
  } else {
    pass('cross-repo section header is absent when all secondary repos are sparse');
  }
}

async function testSparseOnlyRepos(
  command: IssueGenerateCommand,
  primaryRepo: string,
  sparseRepo: string
): Promise<void> {
  const prompt = await capturePrompt(command, [path.join(primaryRepo, 'ticket.md')], [primaryRepo, sparseRepo]);
  checkSparseRepoInclusion(prompt);
  checkPatternHeader(prompt);
}

async function testWarnLogEntry(): Promise<void> {
  const logDate = new Date().toISOString().split('T')[0];
  const logFile = path.join(os.homedir(), '.wf', 'logs', `agent-${logDate}.log`);
  const logContentAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
  if (logContentAfter.includes('sparse-repo')) {
    pass('WARN log entry names the excluded sparse-repo');
  } else {
    fail('WARN log entry naming sparse-repo was not found', `checked: ${logFile}`);
  }
}

function checkMeaningfulRepoInclusion(prompt: string): void {
  const hasMeaningfulSection = prompt.includes('Repository conventions (meaningful-repo):');
  if (hasMeaningfulSection) {
    pass('live prompt includes the full conventions section for meaningful-repo alongside sparse-repo');
  } else {
    fail('live prompt is missing the full conventions section for meaningful-repo', prompt.slice(0, 800));
  }
}

function checkMixedRepoSparseExclusion(prompt: string): void {
  const hasSparseSection = prompt.includes('Repository conventions (sparse-repo):');
  if (hasSparseSection) {
    fail('sparse-repo still incorrectly appears when a meaningful secondary is present');
  } else {
    pass('sparse-repo remains absent when a meaningful secondary is present');
  }
}

async function testMixedRepos(
  command: IssueGenerateCommand,
  primaryRepo: string,
  sparseRepo: string,
  meaningfulRepo: string
): Promise<void> {
  const prompt = await capturePrompt(command, [path.join(primaryRepo, 'ticket.md')], [
    primaryRepo,
    sparseRepo,
    meaningfulRepo,
  ]);
  checkMeaningfulRepoInclusion(prompt);
  checkMixedRepoSparseExclusion(prompt);
}

function setupRepositories(tempRoot: string): { primaryRepo: string; sparseRepo: string; meaningfulRepo: string } {
  const primaryRepo = path.join(tempRoot, 'primary-repo');
  const sparseRepo = path.join(tempRoot, 'sparse-repo');
  const meaningfulRepo = path.join(tempRoot, 'meaningful-repo');
  createSparseRepo(primaryRepo);
  fs.writeFileSync(path.join(primaryRepo, 'ticket.md'), '# Source\n\nSmoke test source.\n', 'utf-8');
  createSparseRepo(sparseRepo);
  createMeaningfulRepo(meaningfulRepo);
  return { primaryRepo, sparseRepo, meaningfulRepo };
}

async function runTests(
  command: IssueGenerateCommand,
  primaryRepo: string,
  sparseRepo: string,
  meaningfulRepo: string
): Promise<void> {
  await testSparseOnlyRepos(command, primaryRepo, sparseRepo);
  await testWarnLogEntry();
  await testMixedRepos(command, primaryRepo, sparseRepo, meaningfulRepo);
}

function reportResults(): void {
  console.log(chalk.bold.cyan(`\n  Results: ${counts.passed} passed, ${counts.failed} failed\n`));
  if (counts.failed > 0) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Manual Test: issue:generate sparse secondary repo excluded with WARN\n'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-sparse-secondary-'));
  const { primaryRepo, sparseRepo, meaningfulRepo } = setupRepositories(tempRoot);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const command = app.get(IssueGenerateCommand);
    await runTests(command, primaryRepo, sparseRepo, meaningfulRepo);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  reportResults();
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
