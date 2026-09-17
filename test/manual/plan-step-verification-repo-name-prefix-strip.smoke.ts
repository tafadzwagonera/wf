/**
 * Manual smoke test: assessor prompt contains repo-name-stripped paths, not workspace-relative paths.
 *
 * Run: nr test:manual -- plan-step-verification-repo-name-prefix-strip.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function makeRepo(): { parentDir: string; repoDir: string } {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-prefix-strip-'));
  const repoDir = path.join(parentDir, 'shop-v1.1');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(path.join(repoDir, 'src'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export {};\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  // Modify without staging so git diff HEAD shows the change.
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const helper = () => {};\n');
  return { parentDir, repoDir };
}

async function main(): Promise<void> {
  console.log('Manual smoke: assessor prompt strips repo-name prefix from step paths\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const { parentDir, repoDir } = makeRepo();

  let capturedPrompt = '';
  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async (opts: { prompt: string }) => {
    capturedPrompt = opts.prompt;
    return { content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) };
  };

  const outcome = await service.run({
    steps: ['Edit shop-v1.1/src/index.ts to export the new helper'],
    planSummary: 'repo name prefix strip smoke test',
    repoDir,
    sessionId: 'sess-prefix-strip',
    stallWindow: 1,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-prefix-strip' }),
  });

  if (capturedPrompt.includes('src/index.ts')) {
    pass('assessor prompt contains the bare repo-relative path (src/index.ts)');
  } else {
    fail('expected assessor prompt to contain src/index.ts', capturedPrompt.slice(0, 300));
  }

  if (capturedPrompt.includes('shop-v1.1/src/index.ts')) {
    fail('expected assessor prompt not to contain shop-v1.1/src/index.ts', capturedPrompt.slice(0, 300));
  } else {
    pass('assessor prompt does not contain the workspace-prefixed spelling (shop-v1.1/src/index.ts)');
  }

  if (outcome.summary?.pending === 0) {
    pass('outcome.summary.pending === 0 — assessor correctly marked the step done');
  } else {
    fail('expected outcome.summary.pending === 0', JSON.stringify(outcome.summary));
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(parentDir, { recursive: true, force: true });
  await app.close();

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: assessor prompt strips repo-name prefix from step paths');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
