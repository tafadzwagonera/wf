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
 * Run: nr test:manual -- step-spec-fidelity-empty-diff-skips-ai-call.smoke
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
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: verifyAll skips AI calls when working-tree diff is empty\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const stepSpecFidelity = app.get(StepSpecFidelityService);
  const gitService = app.get(GitService);
  const aiService = app.get(AiService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-fidelity-empty-diff-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  const baselineSha = git(repoDir, ['rev-parse', 'HEAD']);

  const cleanDiff = await gitService.getDiffFromRef(baselineSha, repoDir);
  if (cleanDiff.trim() === '') {
    pass('Precondition: getDiffFromRef returns empty string for a clean tree');
  } else {
    fail('Precondition failed: expected empty diff for clean tree', cleanDiff.slice(0, 300));
  }

  let aiCallCount = 0;
  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async () => {
    aiCallCount++;
    return { content: '{"findings":[]}' };
  };

  let result: unknown[][] | undefined;
  let threw = false;
  try {
    result = await stepSpecFidelity.verifyAll(['Step A', 'Step B'], repoDir, baselineSha);
  } catch {
    threw = true;
  }
  (aiService as any).execute = originalExecute;

  if (threw) {
    fail('verifyAll threw unexpectedly for a clean tree');
  } else {
    pass('verifyAll does not throw when working tree is clean');
  }

  if (JSON.stringify(result) === JSON.stringify([[], []])) {
    pass('verifyAll returns [[], []] when diff is empty');
  } else {
    fail('Expected verifyAll to return [[], []]', JSON.stringify(result));
  }

  if (aiCallCount === 0) {
    pass('AiService.execute was not called (early-return guard active)');
  } else {
    fail(`Expected 0 AI calls, got ${aiCallCount}`);
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: step-spec-fidelity empty diff skips AI call');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
