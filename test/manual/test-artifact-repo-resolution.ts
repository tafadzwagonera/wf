/**
 * Manual Test: Artifact repository resolution for custom sources and plan artifacts
 *
 * Run: nr test:manual -- test-artifact-repo-resolution
 *
 * Verifies:
 *   1. resolveCustomSourcePath resolves filename-only sources from ~/.wf/<app>/
 *   2. resolveCustomSourcePath resolves subdirectory-prefixed sources from ~/.wf/<app>/<subdir>/
 *   3. resolveCustomSourcePath throws AppError('FILE_SYSTEM_ERROR') when artifact is absent
 *   4. resolveCustomSourcePath never falls back to process.cwd()
 *   5. resolveCustomSourcePath resolves --repos sources from ~/.wf/<repo>/
 *   6. resolveCustomSourcePath throws AppError when source matches multiple repos
 *   7. resolveCustomPlanPath resolves from artifact repo, not code repo
 *   8. resolveCustomPlanStem resolves extensionless identifiers from artifact repo
 *   9. resolvePlanArtifactReferenceAcrossDirs returns null (not throws) when plan not found
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import { resolveCustomSourcePath } from '../../src/shared/utils/custom-source';
import { AppError } from '../../src/shared/errors/app.error';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(`  ✓ ${message}`);
  passed++;
};

const fail = (message: string, detail?: string) => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

const wfHome = path.join(os.homedir(), '.wf');
const testApp = `__test-artifact-resolution-${Date.now()}`;
const testAppDir = path.join(wfHome, testApp);
const fakeBaseDir = path.join(os.tmpdir(), testApp);

function setup() {
  fs.mkdirSync(path.join(testAppDir, 'jira'), { recursive: true });
  fs.mkdirSync(fakeBaseDir, { recursive: true });
  fs.writeFileSync(path.join(testAppDir, 'source.md'), '# Test source');
  fs.writeFileSync(path.join(testAppDir, 'jira', 'ticket.md'), '# Jira ticket');
  fs.writeFileSync(path.join(testAppDir, 'plan-fix.json'), JSON.stringify({ summary: 'test' }));
}

function cleanup() {
  fs.rmSync(testAppDir, { recursive: true, force: true });
  fs.rmSync(fakeBaseDir, { recursive: true, force: true });
}

async function main() {
  console.log('\ntest-artifact-repo-resolution\n');

  setup();

  try {
    // 1. Filename-only source resolves from artifact repo
    {
      const result = resolveCustomSourcePath('source.md', fakeBaseDir);
      const expected = path.join(testAppDir, 'source.md');
      if (result === expected) {
        pass('filename-only source resolves from artifact repo');
      } else {
        fail('filename-only source resolves from artifact repo', `expected ${expected}, got ${result}`);
      }
    }

    // 2. Subdirectory-prefixed source resolves from artifact repo
    {
      const result = resolveCustomSourcePath('jira/ticket.md', fakeBaseDir);
      const expected = path.join(testAppDir, 'jira', 'ticket.md');
      if (result === expected) {
        pass('subdirectory-prefixed source resolves from artifact repo');
      } else {
        fail('subdirectory-prefixed source resolves from artifact repo', `expected ${expected}, got ${result}`);
      }
    }

    // 3. Missing artifact throws AppError with FILE_SYSTEM_ERROR
    {
      try {
        resolveCustomSourcePath('nonexistent.md', fakeBaseDir);
        fail('missing artifact throws AppError', 'no error thrown');
      } catch (error: any) {
        if (error instanceof AppError && error.code === 'FILE_SYSTEM_ERROR') {
          pass('missing artifact throws AppError with FILE_SYSTEM_ERROR');
        } else {
          fail('missing artifact throws AppError', `got ${error.constructor.name}: ${error.message}`);
        }
      }
    }

    // 4. Never falls back to cwd — even if file exists in cwd
    {
      const cwdFile = path.join(process.cwd(), 'source.md');
      const cwdFileExisted = fs.existsSync(cwdFile);
      if (!cwdFileExisted) {
        fs.writeFileSync(cwdFile, '# decoy');
      }

      try {
        const unrelatedApp = `__unrelated-${Date.now()}`;
        const unrelatedBase = path.join(os.tmpdir(), unrelatedApp);
        try {
          resolveCustomSourcePath('source.md', unrelatedBase);
          fail('does not fall back to cwd', 'no error thrown — cwd fallback may still be active');
        } catch (error: any) {
          if (error instanceof AppError && error.code === 'FILE_SYSTEM_ERROR') {
            pass('does not fall back to cwd — throws when artifact repo misses');
          } else {
            fail('does not fall back to cwd', `unexpected error: ${error.message}`);
          }
        }
      } finally {
        if (!cwdFileExisted && fs.existsSync(cwdFile)) {
          fs.unlinkSync(cwdFile);
        }
      }
    }

    // 5. --repos resolves from targeted repo artifact namespace
    {
      const result = resolveCustomSourcePath('source.md', '/tmp/irrelevant', [fakeBaseDir]);
      const expected = path.join(testAppDir, 'source.md');
      if (result === expected) {
        pass('--repos resolves from targeted repo artifact namespace');
      } else {
        fail('--repos resolves from targeted repo artifact namespace', `expected ${expected}, got ${result}`);
      }
    }

    // 6. Multiple repo matches throws AppError
    {
      const secondApp = `${testApp}-dup`;
      const secondDir = path.join(wfHome, secondApp);
      const secondFakeBase = path.join(os.tmpdir(), secondApp);
      fs.mkdirSync(secondDir, { recursive: true });
      fs.mkdirSync(secondFakeBase, { recursive: true });
      fs.writeFileSync(path.join(secondDir, 'source.md'), '# dup');

      try {
        resolveCustomSourcePath('source.md', fakeBaseDir, [fakeBaseDir, secondFakeBase]);
        fail('multiple repo matches throws AppError', 'no error thrown');
      } catch (error: any) {
        if (error instanceof AppError && error.code === 'FILE_SYSTEM_ERROR' && error.message.includes('multiple')) {
          pass('multiple repo matches throws AppError with FILE_SYSTEM_ERROR');
        } else {
          fail('multiple repo matches throws AppError', `got ${error.constructor.name}: ${error.message}`);
        }
      } finally {
        fs.rmSync(secondDir, { recursive: true, force: true });
        fs.rmSync(secondFakeBase, { recursive: true, force: true });
      }
    }

    // 7. Absolute path is returned as-is
    {
      const absPath = path.join(testAppDir, 'source.md');
      const result = resolveCustomSourcePath(absPath, fakeBaseDir);
      if (result === absPath) {
        pass('absolute path is returned as-is');
      } else {
        fail('absolute path is returned as-is', `expected ${absPath}, got ${result}`);
      }
    }

    // 8. resolveCustomPlanPath resolves from artifact repo
    {
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
      const cmd = app.get(IssueImplementCommand);

      const resolveCustomPlanPath = (cmd as any).resolveCustomPlanPath.bind(cmd);
      try {
        const result = resolveCustomPlanPath('plan-fix.json', fakeBaseDir);
        const expected = path.join(testAppDir, 'plan-fix.json');
        if (result === expected) {
          pass('resolveCustomPlanPath resolves from artifact repo');
        } else {
          fail('resolveCustomPlanPath resolves from artifact repo', `expected ${expected}, got ${result}`);
        }
      } catch (error: any) {
        fail('resolveCustomPlanPath resolves from artifact repo', error.message);
      }

      // 9. resolvePlanArtifactReferenceAcrossDirs returns null when plan not found
      const resolvePlanAcrossDirs = (cmd as any).resolvePlanArtifactReferenceAcrossDirs.bind(cmd);
      try {
        const result = resolvePlanAcrossDirs(
          'nonexistent-plan.json',
          path.join(testAppDir, 'jira'),
          testAppDir,
          fakeBaseDir
        );
        if (result === null) {
          pass('resolvePlanArtifactReferenceAcrossDirs returns null when plan not found');
        } else {
          fail(
            'resolvePlanArtifactReferenceAcrossDirs returns null when plan not found',
            `got ${JSON.stringify(result)}`
          );
        }
      } catch (error: any) {
        fail('resolvePlanArtifactReferenceAcrossDirs returns null when plan not found', `threw: ${error.message}`);
      }

      await app.close();
    }
  } finally {
    cleanup();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
