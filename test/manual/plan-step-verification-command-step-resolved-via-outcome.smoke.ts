import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const initRepo = (repoDir: string): void => {
  const runGit = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  };
  runGit('init');
  runGit('config', 'user.email', 'wf@example.test');
  runGit('config', 'user.name', 'wf');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src', 'utils.ts'), 'export const value = 1;\n');
  runGit('add', '.');
  runGit('commit', '-m', 'baseline');
  fs.writeFileSync(path.join(repoDir, 'src', 'utils.ts'), 'export const value = 2;\n');
  runGit('add', '.');
};

const buildRunParams = (repoDir: string) => ({
  steps: ['Run yarn test and ensure all tests pass'],
  planSummary: 'Run the test suite',
  repoDir,
  baseRef: 'HEAD' as const,
  assessorProvider: 'anthropic' as const,
  assessorModel: 'claude-haiku-4-5-20251001',
  assessorBackend: 'cli' as const,
  sessionId: 'smoke-evidence',
  stallWindow: 3,
  verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced' as const, status: 'passed' as const }],
  commitPolicy: { allowsCommit: false, complexity: 'medium' as const },
  runFixRound: async () => ({ sessionId: 'smoke-evidence' }),
});

const assertSummaryContent = (summary: { done: number; unverifiable: number }): void => {
  if (summary.done >= 1) {
    pass(`command step assessed as done (done=${summary.done})`);
  } else {
    fail('command step not assessed as done', JSON.stringify(summary));
  }
  if (summary.unverifiable === 0) {
    pass('no steps left unverifiable');
  } else {
    fail('steps left unverifiable', JSON.stringify(summary));
  }
};

const assertOutcome = (outcome: { summary?: { done: number; unverifiable: number } }): void => {
  if (outcome.summary) {
    assertSummaryContent(outcome.summary);
  } else {
    fail('run() returned no summary');
  }
};

const runWithEvidence = async (repoDir: string): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(PlanStepVerificationService);
    const outcome = await service.run(buildRunParams(repoDir));
    assertOutcome(outcome);
  } finally {
    await app.close();
  }
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  plan-step-verification command step resolved via outcome smoke test\n'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cmd-outcome-'));
  try {
    initRepo(repoDir);
    await runWithEvidence(repoDir);
  } catch (error) {
    fail('run threw unexpectedly', error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
