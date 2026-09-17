/**
 * Manual smoke test: GitService.createBranch enforces sanitization, git ref
 * conventions, and pattern precedence against a real repository
 *
 * Verifies:
 *   1. Surrounding whitespace is trimmed before a real branch is created
 *   2. A pasted `git checkout -b ...` string is rejected for its spaces and
 *      creates no ref
 *   3. Git ref conventions (`..`) hold even under a permissive override pattern
 *   4. A configured git.branchNamePattern is enforced (reject and accept)
 *   5. A --branch-name-pattern override wins over the configured pattern
 *   6. An invalid configured pattern warns and falls back to built-in patterns
 *   7. Rejections are recoverable InvalidBranchNameError instances
 *
 * Run: nr test:manual -- branch-name-enforcement.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { InvalidBranchNameError } from '../../src/shared/utils/errors';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

const branchExists = (dir: string, name: string): boolean =>
  git(dir, ['branch', '--list', name]).includes(name);

async function expectRejection(
  label: string,
  attempt: () => Promise<void>,
  expectedReason: string
): Promise<void> {
  try {
    await attempt();
    fail(label, 'expected InvalidBranchNameError, but the call succeeded');
  } catch (error) {
    const isExpected
      = error instanceof InvalidBranchNameError
        && error.recoverable === true
        && (error as Error).message.includes(expectedReason);
    if (isExpected) {
      pass(label);
    } else {
      fail(label, `got: ${(error as Error).name}: ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: GitService.createBranch enforcement\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const configService = app.get(ConfigService);
  const logger = app.get(LoggerService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-name-enforcement-'));
  git(repoDir, ['init', '-q', '-b', 'develop']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'base']);

  let configuredPattern: string | undefined;
  const originalGet = configService.get.bind(configService);
  (configService as any).get = (key: string, fallback?: unknown) =>
    key === 'git.branchNamePattern' ? configuredPattern : originalGet(key, fallback);

  const warnings: string[] = [];
  const originalWarn = logger.warn.bind(logger);
  (logger as any).warn = (message: string) => {
    warnings.push(message);
    return originalWarn(message);
  };

  try {
    await gitService.createBranch('  fix/WBP-1__trim-check  ', { baseBranch: 'develop', cwd: repoDir });
    if (branchExists(repoDir, 'fix/WBP-1__trim-check')) {
      pass('whitespace-padded name created the trimmed branch fix/WBP-1__trim-check');
    } else {
      fail('trimmed branch was not created', git(repoDir, ['branch', '--list']));
    }

    git(repoDir, ['checkout', '-q', 'develop']);
    const branchesBefore = git(repoDir, ['branch', '--list']);
    await expectRejection(
      'pasted `git checkout -b ...` string is rejected for its spaces',
      () => gitService.createBranch('git checkout -b fix/WBP-1__pasted', { baseBranch: 'develop', cwd: repoDir }),
      'cannot contain spaces'
    );
    if (git(repoDir, ['branch', '--list']) === branchesBefore && git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'develop') {
      pass('rejected call created no ref and left HEAD on develop');
    } else {
      fail('rejected call mutated the repository', git(repoDir, ['branch', '--list']));
    }

    await expectRejection(
      'git ref conventions hold under a permissive override pattern',
      () => gitService.createBranch('fix/a..b', { baseBranch: 'develop', cwd: repoDir, patternOverride: '.+' }),
      '".."'
    );

    configuredPattern = '^team\\/[a-z-]+$';
    await expectRejection(
      'configured git.branchNamePattern rejects a non-matching name and names the pattern',
      () => gitService.createBranch('fix/anything', { baseBranch: 'develop', cwd: repoDir }),
      '^team\\/[a-z-]+$'
    );
    await gitService.createBranch('team/allowed', { baseBranch: 'develop', cwd: repoDir });
    if (branchExists(repoDir, 'team/allowed')) {
      pass('configured pattern accepts team/allowed and the branch exists for real');
    } else {
      fail('team/allowed was not created', git(repoDir, ['branch', '--list']));
    }

    await gitService.createBranch('fix/override-wins', {
      baseBranch: 'develop', cwd: repoDir, patternOverride: '^[a-z]+\\/[\\w-]+$',
    });
    if (branchExists(repoDir, 'fix/override-wins')) {
      pass('--branch-name-pattern override wins over the stricter configured pattern');
    } else {
      fail('override-pattern branch was not created', git(repoDir, ['branch', '--list']));
    }

    configuredPattern = '[';
    warnings.length = 0;
    await gitService.createBranch('fix/WBP-1__fallback', { baseBranch: 'develop', cwd: repoDir });
    if (branchExists(repoDir, 'fix/WBP-1__fallback')) {
      pass('invalid configured pattern falls back to built-in patterns without crashing');
    } else {
      fail('fallback branch was not created', git(repoDir, ['branch', '--list']));
    }
    if (warnings.some(w => w.includes('git.branchNamePattern'))) {
      pass('a warning naming git.branchNamePattern was emitted for the invalid regex');
    } else {
      fail('expected a warning naming git.branchNamePattern', JSON.stringify(warnings));
    }
  } finally {
    (configService as any).get = originalGet;
    (logger as any).warn = originalWarn;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: GitService.createBranch enforcement');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
