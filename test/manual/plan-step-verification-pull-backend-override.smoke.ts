/**
 * Manual smoke test: assessorBackend flows to PullStepAssessorService when mode is pull
 *
 * Scenario: When `planStepVerification.backend: 'cli'` is set with `mode: 'pull'`, the backend override
 * must reach `PullStepAssessorService.assess()` and be forwarded to `StageAgentService.chatTurn()` as
 * `backendOverride: 'cli'`. Before this fix, `assessorBackend` was forwarded only in push mode
 * (`requestPushAssessment`); the pull path (`runPullAssessment`) silently dropped it, so the backend
 * config had no effect and no log distinguished CLI from agent SDK routing.
 *
 * Config under test:
 *   ```ts
 *   stages: {
 *     implement: {
 *       provider: 'anthropic',
 *       backend: 'agent',
 *       planStepVerification: {
 *         enabled: true,
 *         mode: 'pull',
 *         provider: 'anthropic',
 *         model: 'claude-haiku-4-5-20251001',
 *         backend: 'cli',
 *       },
 *     },
 *   }
 *   ```
 *
 * Verify:
 *   1. `PullStepAssessorService.assess({ ..., backend: 'cli' })` completes without throwing
 *   2. Console output captured during the call contains the CLI-backend indicator string and does NOT
 *      contain `[anthropic-agent]` — confirming `chatTurn` received `backendOverride: 'cli'`
 *   3. The returned `statuses` array has exactly one entry with `index: 0` and a recognized status value
 *      (`done`, `not-done`, `partially-done`, `not-applicable`, or `unverifiable`)
 *
 * Wire up: Bootstrap `AppModule` using `NestFactory.createApplicationContext` with a config that enables
 * stage-agent for the 'implement' stage (`stages.implement.backend: 'agent'`). Initialize a temp git repo:
 * one baseline commit containing `src/bar.ts`, then write a change to `src/bar.ts` without committing.
 * Obtain `PullStepAssessorService` from the app context and call:
 *   `assess({
 *     steps: [{ index: 0, text: 'Update src/bar.ts to export a helper function' }],
 *     repoDir,
 *     baseRef: 'HEAD',
 *     provider: 'anthropic',
 *     model: 'claude-haiku-4-5-20251001',
 *     backend: 'cli',
 *   })`
 * Intercept `console.log` before the call (clone the pattern from `plan-step-verification-modes.smoke.ts`)
 * and restore it in a `finally` block.
 *
 * Teardown: `await app.close()`, `fs.rmSync(repoDir, { recursive: true, force: true })`, restore `console.log`.
 *
 * Run: nr test:manual plan-step-verification-pull-backend-override.smoke
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PullStepAssessorService } from '../../src/agents/pull-step-assessor.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const CLI_BACKEND_LABEL = 'claude-cli';
const knownStatuses = new Set(['done', 'not-done', 'partially-done', 'not-applicable', 'unverifiable']);
const ansiPattern = new RegExp(String.fromCodePoint(27) + String.raw`\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replaceAll(ansiPattern, '');

const interceptConsole = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(String).join(' ')));
    original(...args);
  };
  const restore = (): void => {
    console.log = original;
  };
  return { lines, restore };
};

const initRepo = (repoDir: string): void => {
  const runGit = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  };
  runGit('init');
  runGit('config', 'user.email', 'wf@example.test');
  runGit('config', 'user.name', 'wf');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src', 'bar.ts'), 'export const value = 1;\n');
  runGit('add', '.');
  runGit('commit', '-m', 'baseline');
  fs.writeFileSync(path.join(repoDir, 'src', 'bar.ts'), 'export const updatedValue = 2;\n');
};

const assertPullResult = (statuses: { index: number; status: string }[], lines: string[]): void => {
  if (lines.some(l => l.includes(`[${CLI_BACKEND_LABEL}]`))) {
    pass('pull assessor call routed through CLI backend');
  } else {
    fail('pull assessor call did not route through CLI backend', lines.join(' | ') || '(none)');
  }
  const entry = statuses.find(s => s.index === 0);
  if (entry && knownStatuses.has(entry.status)) {
    pass(`statuses contains a valid entry for step index 0 (${entry.status})`);
  } else {
    fail('statuses missing or invalid entry for step index 0', JSON.stringify(statuses));
  }
};

const assertInspectedPaths = (inspectedPaths: string[]): void => {
  if (inspectedPaths.includes('src/bar.ts')) {
    pass('inspectedPaths covers the checklist');
  } else {
    fail('inspectedPaths missing checklist file', JSON.stringify(inspectedPaths));
  }
};

const buildAssessParams = (repoDir: string) => ({
  steps: [{ index: 0, text: 'Update src/bar.ts to export a helper function' }],
  repoDir,
  baseRef: 'HEAD' as const,
  changedPaths: ['src/bar.ts'],
  untrackedPaths: [] as string[],
  provider: 'anthropic' as const,
  model: 'claude-haiku-4-5-20251001',
  backend: 'cli' as const,
});

const runPullWithCliBackend = async (repoDir: string): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(PullStepAssessorService);
    const { lines, restore } = interceptConsole();
    const { statuses, inspectedPaths } = await service.assess(buildAssessParams(repoDir)).finally(restore);
    assertPullResult(statuses, lines);
    assertInspectedPaths(inspectedPaths);
  } finally {
    await app.close();
  }
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  planStepVerification pull-mode backend override smoke test\n'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pull-backend-'));
  try {
    initRepo(repoDir);
    await runPullWithCliBackend(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
