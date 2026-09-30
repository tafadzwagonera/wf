import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PullStepAssessorService } from '../../src/agents/pull-step-assessor.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-step-verification-'));

const runGit = (...args: string[]): void => {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
};

const verifyPullAssessment = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const assessor = app.get(PullStepAssessorService);
    const statuses = await assessor.assess(pullAssessmentParams());
    reportPullStatuses(statuses);
  } finally {
    await app.close();
  }
};

const pullAssessmentParams = () => ({
  steps: [{ index: 0, text: 'Update src/large.ts' }, { index: 1, text: 'Update src/absent.ts' }],
  repoDir,
  baseRef: 'HEAD',
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-6',
});

const reportPullStatuses = (statuses: { index: number; status: string }[]): void => {
  const first = statuses.find(status => status.index === 0)?.status;
  const second = statuses.find(status => status.index === 1)?.status;
  if (first !== 'done' || second !== 'not-done') {
    fail('pull assessment returned unexpected statuses', JSON.stringify(statuses));
    return;
  }
  pass('pull assessment distinguishes changed and absent files');
};

const initializeRepository = (): void => {
  runGit('init');
  runGit('config', 'user.email', 'wf@example.test');
  runGit('config', 'user.name', 'wf');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src', 'large.ts'), 'export const value = 1;\n');
  runGit('add', '.');
  runGit('commit', '-m', 'baseline');
};

const main = async (): Promise<void> => {
  try {
    initializeRepository();
    fs.writeFileSync(path.join(repoDir, 'src', 'large.ts'), 'export const value = 2;\n');
    try {
      await verifyPullAssessment();
    } catch (error) {
      fail('pull assessment could not run', error instanceof Error ? error.message : String(error));
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  process.exitCode = counts.failed > 0 ? 1 : 0;
};

void main();
