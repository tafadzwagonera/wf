/**
 * Manual smoke test: standalone issue:implement new-repo parity
 *
 * Run: nr test:manual -- test-new-repo-implement-parity
 *
 * Verifies:
 *   1. isNewRepo propagates through buildImplementOpts in standalone implement
 *   2. Silent mode auto-scaffolds via standalone implement
 *   3. validateUnresolvedRepos throws for repos not in newRepositories
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const overrideHomeDir = (nextHomeDir: string): (() => void) => {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = previousHome;
  };
};

const captureOutput = async (fn: () => Promise<void>): Promise<{ output: string }> => {
  const chunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit.bind(process);
  (process.stdout.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return (originalStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  (process.stderr.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  (process.exit as unknown) = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  try {
    await fn();
  } catch {
    // swallow
  } finally {
    (process.stdout.write as unknown) = originalStdoutWrite;
    (process.stderr.write as unknown) = originalStderrWrite;
    (process.exit as unknown) = originalExit;
  }
  return { output: chunks.join('') };
};

const makeCustomPlanFixtures = (opts: {
  planName: string;
  affectedRepositories: string[];
  newRepositories?: string[];
}): { tmpRoot: string; appDir: string; planPath: string; cleanup: () => void } => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-impl-parity-'));
  const homeDir = path.join(tmpRoot, 'home');
  const appDir = path.join(tmpRoot, 'consumer-app');
  const customArtifactDir = path.join(homeDir, '.wf', 'consumer-app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(customArtifactDir, { recursive: true });

  // Init git in consumer-app
  execSync('git init', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: appDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: appDir, stdio: 'ignore' });

  const plan: Record<string, unknown> = {
    action: 'fix',
    summary: 'Test implement parity',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [],
    affectedRepositories: opts.affectedRepositories,
  };
  if (opts.newRepositories) plan.newRepositories = opts.newRepositories;

  const planPath = path.join(customArtifactDir, `${opts.planName}-fix.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

  return {
    tmpRoot,
    appDir,
    planPath,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
};

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueImplementCommand);
  const implementer = (command as any).orchestrator.implementer as {
    execute: (ticket: TicketArtifact, plan: PlanArtifact, opts: ImplementerOptions) => Promise<unknown>;
  };

  console.log('\nTest 1: standalone implement propagates isNewRepo from plan\n' + '-'.repeat(60));
  {
    const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({
      planName: 'extract-lib',
      affectedRepositories: ['consumer-app', 'new-lib'],
      newRepositories: ['new-lib'],
    });
    const originalCwd = process.cwd.bind(process);
    const restoreHome = overrideHomeDir(path.join(tmpRoot, 'home'));
    (process as any).cwd = () => appDir;

    const capturedOptions: ImplementerOptions[] = [];
    const origExecute = implementer.execute.bind(implementer);
    implementer.execute = async (_t: TicketArtifact, _p: PlanArtifact, opts: ImplementerOptions) => {
      capturedOptions.push(opts);
      return { type: 'implementation', branchName: 'fix/extract-lib' };
    };

    try {
      const { output } = await captureOutput(() =>
        command.run(['extract-lib-fix.json'], {
          repos: ['consumer-app'],
          silent: true,
        })
      );

      // new-lib should have been auto-scaffolded
      const scaffoldedDir = path.resolve(appDir, '..', 'new-lib');
      if (fs.existsSync(scaffoldedDir)) {
        pass('new-lib directory was auto-scaffolded');
      } else {
        fail('new-lib directory was NOT scaffolded', `expected at: ${scaffoldedDir}`);
      }

      // In silent mode, the scaffold log is suppressed (if (!silent))
      if (!output.includes('Scaffolded new repository:')) {
        pass('silent mode suppresses scaffold log output');
      } else {
        fail('silent mode should suppress scaffold log output');
      }

      // Find the options for the new-lib repo invocation
      const newLibOpts = capturedOptions.find(o => o.isNewRepo === true);
      if (newLibOpts) {
        pass('implementer received isNewRepo=true for new-lib');
      } else {
        fail('implementer did NOT receive isNewRepo=true for any repo',
          `captured: ${JSON.stringify(capturedOptions.map(o => ({ repoDir: o.repoDir, isNewRepo: o.isNewRepo })))}`);
      }

      // The consumer-app invocation should have isNewRepo=false
      const consumerOpts = capturedOptions.find(o => o.isNewRepo === false);
      if (consumerOpts) {
        pass('implementer received isNewRepo=false for consumer-app');
      } else {
        fail('implementer did NOT receive isNewRepo=false for consumer-app');
      }
    } finally {
      implementer.execute = origExecute;
      (process as any).cwd = originalCwd;
      restoreHome();
      cleanup();
    }
  }

  console.log('\nTest 2: standalone implement rejects unresolvable repos not in newRepositories\n' + '-'.repeat(60));
  {
    const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({
      planName: 'typo-plan',
      affectedRepositories: ['consumer-app', 'typo-repo'],
      newRepositories: [],
    });
    const originalCwd = process.cwd.bind(process);
    const restoreHome = overrideHomeDir(path.join(tmpRoot, 'home'));
    (process as any).cwd = () => appDir;

    const origExecute = implementer.execute.bind(implementer);
    let implementerCalled = false;
    implementer.execute = async () => {
      implementerCalled = true;
      return { type: 'implementation', branchName: 'fix/typo' };
    };

    try {
      const { output } = await captureOutput(() =>
        command.run(['typo-plan-fix.json'], {
          repos: ['consumer-app'],
          silent: true,
        })
      );

      if (output.includes('Plan references repositories not found locally: typo-repo')) {
        pass('output includes unresolvable repo error');
      } else {
        fail('output missing unresolvable repo error', output.slice(-400));
      }

      if (output.includes('newRepositories')) {
        pass('error suggests adding to newRepositories');
      } else {
        fail('error missing newRepositories suggestion');
      }

      if (!implementerCalled) {
        pass('implementer was NOT called');
      } else {
        fail('implementer should not have been called');
      }
    } finally {
      implementer.execute = origExecute;
      (process as any).cwd = originalCwd;
      restoreHome();
      cleanup();
    }
  }

  console.log('\nTest 3: no scaffolding when plan has no newRepositories\n' + '-'.repeat(60));
  {
    const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({
      planName: 'no-new-repos',
      affectedRepositories: ['consumer-app'],
    });
    const originalCwd = process.cwd.bind(process);
    const restoreHome = overrideHomeDir(path.join(tmpRoot, 'home'));
    (process as any).cwd = () => appDir;

    const capturedOptions: ImplementerOptions[] = [];
    const origExecute = implementer.execute.bind(implementer);
    implementer.execute = async (_t: TicketArtifact, _p: PlanArtifact, opts: ImplementerOptions) => {
      capturedOptions.push(opts);
      return { type: 'implementation', branchName: 'fix/no-new' };
    };

    try {
      const { output } = await captureOutput(() =>
        command.run(['no-new-repos-fix.json'], {
          repos: ['consumer-app'],
          silent: true,
        })
      );

      if (!output.includes('Scaffolded new repository:')) {
        pass('no scaffold output when newRepositories is absent');
      } else {
        fail('unexpected scaffold output');
      }

      if (capturedOptions.length > 0 && capturedOptions.every(o => o.isNewRepo === false)) {
        pass('all implementer calls have isNewRepo=false');
      } else if (capturedOptions.length === 0) {
        fail('implementer was not called at all');
      } else {
        fail('unexpected isNewRepo=true in options');
      }
    } finally {
      implementer.execute = origExecute;
      (process as any).cwd = originalCwd;
      restoreHome();
      cleanup();
    }
  }

  await app.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
