/**
 * Manual smoke test: new-repo interactive confirmation and silent auto-scaffold
 *
 * Run: nr test:manual -- test-new-repo-confirmation-and-scaffold
 *
 * Verifies:
 *   1. Silent mode auto-scaffolds new repos via the full IssueCommand pipeline
 *   2. Interactive mode prompts user and validates directory + wf.config.* exist
 *   3. Interactive mode throws when user confirms but directory is missing
 *   4. Interactive mode throws when user confirms but wf.config.* is missing
 *   5. Interactive mode returns original repos when user declines
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import { hashPlanArtifactSources, buildPlanArtifactFilename, buildPlanArtifactManifestPath } from '../../src/shared/utils/plan-artifact';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import inquirer from 'inquirer';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  \u2713 ${message}`);
  passed++;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

const makeFixtures = (opts: {
  ticketKey: string;
  newRepositories?: string[];
  affectedRepositories?: string[];
}): { tmpRoot: string; homeDir: string; appDir: string; cleanup: () => void } => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-newrepo-'));
  const homeDir = path.join(tmpRoot, 'home');
  const appDir = path.join(tmpRoot, 'primary-app');
  const platformDir = path.join(homeDir, '.wf', 'primary-app', 'jira');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(platformDir, { recursive: true });

  execSync('git init', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: appDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: appDir, stdio: 'ignore' });

  fs.writeFileSync(
    path.join(platformDir, `${opts.ticketKey}.md`),
    `# ${opts.ticketKey}: Test\n\n**Type:** Task\n**Status:** Open\n\n## Description\n\nTest.\n`,
    'utf-8'
  );

  const plan: Record<string, unknown> = {
    action: 'fix',
    summary: 'Test new repo scaffold',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedRepositories: opts.affectedRepositories ?? ['primary-app'],
  };
  if (opts.newRepositories) plan.newRepositories = opts.newRepositories;

  const hash = hashPlanArtifactSources([opts.ticketKey]);
  const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });
  const planPath = path.join(platformDir, planFilename);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

  const manifestPath = buildPlanArtifactManifestPath(planPath);
  fs.writeFileSync(manifestPath, JSON.stringify({
    artifactPath: planPath, action: 'fix', createdAt: new Date().toISOString(),
    format: 'json', hash, sourceKind: 'ticket', sourceName: opts.ticketKey,
    ticketKey: opts.ticketKey, trackerName: 'jira',
  }, null, 2), 'utf-8');

  return {
    tmpRoot, homeDir, appDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
};

const buildPlanArtifactForExpand = (
  affectedRepositories: string[], newRepositories?: string[]
): PlanArtifact => ({
  action: 'fix',
  path: '/tmp/test-plan.json',
  plan: {
    action: 'fix', summary: 'Test', steps: [], estimatedComplexity: 'low' as const,
    affectedFiles: [], affectedRepositories, newRepositories,
  },
});

const captureOutput = async (fn: () => Promise<void>): Promise<{ output: string }> => {
  const chunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);
  (process.stdout.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return (origStdout as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  (process.stderr.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return (origStderr as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  (process.exit as unknown) = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  try {
    await fn();
  } catch { /* swallow */ } finally {
    (process.stdout.write as unknown) = origStdout;
    (process.stderr.write as unknown) = origStderr;
    (process.exit as unknown) = origExit;
  }
  return { output: chunks.join('') };
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);
  const implementer = (command as any).agents.implementer as {
    execute: (ticket: TicketArtifact, plan: PlanArtifact, opts: ImplementerOptions) => Promise<unknown>;
  };

  console.log('\nTest 1: silent mode auto-scaffolds new repos without prompting\n' + '-'.repeat(60));
  {
    const { homeDir, appDir, cleanup } = makeFixtures({
      ticketKey: 'NR-1',
      affectedRepositories: ['primary-app', 'auto-svc'],
      newRepositories: ['auto-svc'],
    });
    const originalCwd = process.cwd.bind(process);
    const originalHome = process.env.HOME;
    (process as any).cwd = () => appDir;
    process.env.HOME = homeDir;

    const origExecute = implementer.execute.bind(implementer);
    const capturedOptions: ImplementerOptions[] = [];
    implementer.execute = async (_t: TicketArtifact, _p: PlanArtifact, opts: ImplementerOptions) => {
      capturedOptions.push(opts);
      return { type: 'implementation', branchName: 'fix/NR-1' };
    };

    try {
      await captureOutput(() =>
        command.run([], {
          ticketKey: 'NR-1', from: 'implement', to: 'implement',
          action: 'fix', repos: ['primary-app'], silent: true,
        })
      );

      const scaffoldedDir = path.resolve(appDir, '..', 'auto-svc');
      if (fs.existsSync(scaffoldedDir)) pass('auto-svc directory was scaffolded');
      else fail('auto-svc directory was NOT scaffolded', `expected: ${scaffoldedDir}`);

      if (fs.existsSync(path.join(scaffoldedDir, '.git'))) pass('auto-svc has a .git directory');
      else fail('auto-svc does not have a .git directory');

      const newRepoOpts = capturedOptions.find(o => o.isNewRepo);
      if (newRepoOpts) pass('implementer received isNewRepo=true for auto-svc');
      else fail('implementer did not receive isNewRepo=true');
    } finally {
      implementer.execute = origExecute;
      (process as any).cwd = originalCwd;
      process.env.HOME = originalHome;
      cleanup();
    }
  }

  console.log('\nTest 2: interactive prompt confirms when directory and config exist\n' + '-'.repeat(60));
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
    const appDir = path.join(tmpRoot, 'primary-app');
    fs.mkdirSync(appDir, { recursive: true });
    const newRepoDir = path.resolve(appDir, '..', 'confirmed-svc');

    const originalCwd = process.cwd.bind(process);
    (process as any).cwd = () => appDir;
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const origPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => {
      fs.mkdirSync(newRepoDir, { recursive: true });
      fs.writeFileSync(path.join(newRepoDir, 'wf.config.ts'), 'export default {};', 'utf-8');
      return { ready: true };
    };

    try {
      const planArtifact = buildPlanArtifactForExpand(['primary-app', 'confirmed-svc'], ['confirmed-svc']);
      const { output } = await captureOutput(async () => {
        const result = await (command as any).expandReposFromPlan(
          [undefined], planArtifact, appDir, false
        );
        if (result.includes('confirmed-svc')) pass('confirmed-svc is in returned repos');
        else fail('confirmed-svc missing from returned repos', JSON.stringify(result));
      });

      if (output.includes('The plan requires new repositories')) pass('output includes manual setup instructions');
      else fail('output missing manual setup instructions');

      if (output.includes('Confirmed new repository:')) pass('output includes confirmation message');
      else fail('output missing confirmation message');
    } finally {
      (inquirer as any).prompt = origPrompt;
      (process as any).cwd = originalCwd;
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log('\nTest 3: throws when user confirms but directory is missing\n' + '-'.repeat(60));
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
    const appDir = path.join(tmpRoot, 'primary-app');
    fs.mkdirSync(appDir, { recursive: true });

    const originalCwd = process.cwd.bind(process);
    (process as any).cwd = () => appDir;
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const origPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => ({ ready: true });

    try {
      const planArtifact = buildPlanArtifactForExpand(['primary-app', 'missing-dir-svc'], ['missing-dir-svc']);
      let threwValidation = false;
      const { output } = await captureOutput(async () => {
        try {
          await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
        } catch (err: unknown) {
          threwValidation = (err as Error).message.includes('directory not found');
          throw err;
        }
      });

      if (threwValidation) pass('threw ValidationError with "directory not found"');
      else fail('did not throw expected ValidationError');

      if (output.includes('directory not found')) pass('output includes "directory not found"');
      else fail('output missing "directory not found"');
    } finally {
      (inquirer as any).prompt = origPrompt;
      (process as any).cwd = originalCwd;
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log('\nTest 4: throws when user confirms but wf.config.* is missing\n' + '-'.repeat(60));
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
    const appDir = path.join(tmpRoot, 'primary-app');
    fs.mkdirSync(appDir, { recursive: true });
    const noConfigDir = path.resolve(appDir, '..', 'no-config-svc');

    const originalCwd = process.cwd.bind(process);
    (process as any).cwd = () => appDir;
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const origPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => {
      // Create directory but NO wf.config.*
      fs.mkdirSync(noConfigDir, { recursive: true });
      return { ready: true };
    };

    try {
      const planArtifact = buildPlanArtifactForExpand(['primary-app', 'no-config-svc'], ['no-config-svc']);
      let threwValidation = false;
      const { output } = await captureOutput(async () => {
        try {
          await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
        } catch (err: unknown) {
          threwValidation = (err as Error).message.includes('wf.config.* not found');
          throw err;
        }
      });

      if (threwValidation) pass('threw ValidationError with "wf.config.* not found"');
      else fail('did not throw expected ValidationError');

      if (output.includes('wf.config.* not found')) pass('output includes "wf.config.* not found"');
      else fail('output missing "wf.config.* not found"');
    } finally {
      (inquirer as any).prompt = origPrompt;
      (process as any).cwd = originalCwd;
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log('\nTest 5: returns original repos when user declines confirmation\n' + '-'.repeat(60));
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
    const appDir = path.join(tmpRoot, 'primary-app');
    fs.mkdirSync(appDir, { recursive: true });

    const originalCwd = process.cwd.bind(process);
    (process as any).cwd = () => appDir;
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const origPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => ({ ready: false });

    try {
      const planArtifact = buildPlanArtifactForExpand(['primary-app', 'declined-svc'], ['declined-svc']);
      const result = await (command as any).expandReposFromPlan(
        [undefined], planArtifact, appDir, false
      );

      if (!result.includes('declined-svc')) pass('declined-svc is NOT in returned repos');
      else fail('declined-svc should not be in returned repos');

      if (result.includes(undefined)) pass('original repos preserved');
      else fail('original repos missing from result');

      const declinedDir = path.resolve(appDir, '..', 'declined-svc');
      if (!fs.existsSync(declinedDir)) pass('declined-svc was NOT scaffolded');
      else fail('declined-svc should not exist');
    } finally {
      (inquirer as any).prompt = origPrompt;
      (process as any).cwd = originalCwd;
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  await app.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
