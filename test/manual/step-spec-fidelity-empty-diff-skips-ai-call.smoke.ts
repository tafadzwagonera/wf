/**
 * Manual smoke test: StepSpecFidelityService.run does not call AiService when
 * the captured diff is empty or whitespace-only
 *
 * Scenario: A temp git repo has a clean working tree at the time verifyAll is
 * called. captureDiff returns an empty string (git diff <sha> produces no
 * output). run() must return [] immediately for every step and must not call
 * AiService.execute at all. This verifies the early-return guard is reachable
 * through the real NestJS DI path.
 *
 * Verifies:
 *   1. GitService.getDiffFromRef(baselineSha, cleanRepoDir) returns ''
 *      or whitespace — confirming the clean-tree precondition holds
 *   2. verifyAll(['Step A', 'Step B'], cleanRepoDir, baselineSha) resolves to
 *      [[], []]
 *   3. AiService.execute was not called (call count === 0)
 *   4. verifyAll does not throw when the working tree is clean
 *
 * Run: nr test:manual step-spec-fidelity-empty-diff-skips-ai-call.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { StepSpecFidelityService } from '../../src/agents/step-spec-fidelity.service';
import { GitService } from '../../src/integrations/git/git.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function createTempRepo(): { repoDir: string; baselineSha: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-fidelity-empty-diff-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  const baselineSha = git(repoDir, ['rev-parse', 'HEAD']);
  return { repoDir, baselineSha };
}

async function checkEmptyDiff(gitService: GitService, repoDir: string, baselineSha: string): Promise<void> {
  const cleanDiff = await gitService.getDiffFromRef(baselineSha, repoDir);
  if (cleanDiff.trim() === '') {
    pass('Precondition: getDiffFromRef returns empty string for a clean tree');
  } else {
    fail('Precondition failed: expected empty diff for clean tree', cleanDiff.slice(0, 300));
  }
}

function stubAiService(aiService: AiService): { getCallCount: () => number; restore: () => void } {
  let aiCallCount = 0;
  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async () => {
    aiCallCount++;
    return { content: '{"findings":[]}' };
  };
  return {
    getCallCount: () => aiCallCount,
    restore: () => { (aiService as any).execute = originalExecute; },
  };
}

async function runVerifyAll(
  stepSpecFidelity: StepSpecFidelityService,
  repoDir: string,
  baselineSha: string,
): Promise<{ threw: boolean; result: unknown[][] | undefined }> {
  let result: unknown[][] | undefined;
  let threw = false;
  try {
    result = await stepSpecFidelity.verifyAll(['Step A', 'Step B'], repoDir, baselineSha);
  } catch {
    threw = true;
  }
  return { threw, result };
}

function checkAiCallCount(aiCallCount: number): void {
  if (aiCallCount === 0) {
    pass('AiService.execute was not called (early-return guard active)');
  } else {
    fail(`Expected 0 AI calls, got ${aiCallCount}`);
  }
}

function checkVerifyAllResult(threw: boolean, result: unknown[][] | undefined, aiCallCount: number): void {
  if (!threw) {
    pass('verifyAll does not throw when working tree is clean');
  } else {
    fail('verifyAll threw unexpectedly for a clean tree');
  }
  if (JSON.stringify(result) === JSON.stringify([[], []])) {
    pass('verifyAll returns [[], []] when diff is empty');
  } else {
    fail('Expected verifyAll to return [[], []]', JSON.stringify(result));
  }
  checkAiCallCount(aiCallCount);
}

async function runTests(
  stepSpecFidelity: StepSpecFidelityService,
  gitService: GitService,
  aiService: AiService,
  repoDir: string,
  baselineSha: string,
): Promise<void> {
  await checkEmptyDiff(gitService, repoDir, baselineSha);
  const { getCallCount, restore } = stubAiService(aiService);
  const { threw, result } = await runVerifyAll(stepSpecFidelity, repoDir, baselineSha);
  restore();
  checkVerifyAllResult(threw, result, getCallCount());
}

async function main(): Promise<void> {
  console.log('Manual smoke: verifyAll skips AI calls when working-tree diff is empty\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const stepSpecFidelity = app.get(StepSpecFidelityService);
  const gitService = app.get(GitService);
  const aiService = app.get(AiService);
  const { repoDir, baselineSha } = createTempRepo();
  await runTests(stepSpecFidelity, gitService, aiService, repoDir, baselineSha);
  fs.rmSync(repoDir, { recursive: true, force: true });
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
