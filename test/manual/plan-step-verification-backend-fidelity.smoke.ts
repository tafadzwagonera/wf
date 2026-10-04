/**
 * Manual smoke test: planStepVerification.backend routes fidelity pre-pass through the configured stage backend
 *
 * Scenario: When `planStepVerification.backend: 'cli'` is set alongside an explicit provider and model,
 * `StepSpecFidelityService.verifyAll()` must route each per-step AI call through the CLI backend, not
 * the agent SDK. Before this change, setting `provider` + `model` in `planStepVerification` caused
 * `tryStageBackendExecute` to short-circuit to null, bypassing stage-agent entirely; the fidelity call
 * fell through to the raw completion adapter and `backend` had no observable effect.
 *
 * Config under test:
 *   ```ts
 *   stages: {
 *     implement: {
 *       provider: 'anthropic',
 *       backend: 'agent',
 *       planStepVerification: {
 *         enabled: true,
 *         provider: 'anthropic',
 *         model: 'claude-haiku-4-5-20251001',
 *         backend: 'cli',
 *       },
 *     },
 *   }
 *   ```
 *
 * Verify:
 *   1. `StepSpecFidelityService.verifyAll()` completes without throwing
 *   2. Console output captured during the call contains the CLI-backend indicator string
 *      (e.g., the value of `CLI_STAGE_LABEL`) and does NOT contain `[anthropic-agent]`
 *   3. `verifyAll()` returns `{ failures: [] }` — no provider or diff failures
 *   4. The `findingsPerStep` map contains an entry for step index 0 (may be empty; confirms the
 *      AI call reached the model and returned a parseable response)
 *
 * Wire up: Bootstrap `AppModule` using `NestFactory.createApplicationContext` with an in-memory config
 * override that sets `stages.implement.backend: 'agent'` and
 * `stages.implement.planStepVerification.backend: 'cli'` (stage-agent must be enabled for 'implement').
 * Initialize a temp git repo via `execFileSync`: one baseline commit containing `src/foo.ts`, then
 * write a one-line change to `src/foo.ts` without committing so that `getDiffFromRef('HEAD')` returns
 * a non-empty diff. Obtain `StepSpecFidelityService` from the app context and call:
 *   `verifyAll(
 *     [{ index: 0, text: 'Update src/foo.ts to export a named constant' }],
 *     repoDir,
 *     'HEAD',
 *     { assessorProvider: 'anthropic', assessorModel: 'claude-haiku-4-5-20251001', assessorBackend: 'cli' }
 *   )`
 * Intercept `console.log` before the call (clone the approach from `skill-load-observability.smoke.ts`)
 * and restore it in a `finally` block.
 *
 * Teardown: `await app.close()`, `fs.rmSync(repoDir, { recursive: true, force: true })`, restore `console.log`.
 *
 * Run: nr test:manual plan-step-verification-backend-fidelity.smoke
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { StepSpecFidelityService } from '../../src/agents/step-spec-fidelity.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const CLI_BACKEND_LABEL = 'claude-cli';
const ANSI_PATTERN = new RegExp(String.fromCodePoint(27) + String.raw`\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replaceAll(ANSI_PATTERN, '');

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
  fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'export const value = 1;\n');
  runGit('add', '.');
  runGit('commit', '-m', 'baseline');
  fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'export const updatedValue = 2;\n');
};

const assertFidelityContent = (result: { failures: unknown[]; findingsPerStep: Map<number, unknown> }): void => {
  if (result.failures.length === 0) {
    pass('verifyAll returned no failures');
  } else {
    fail('verifyAll returned failures', JSON.stringify(result.failures));
  }
  if (result.findingsPerStep.has(0)) {
    pass('findingsPerStep contains an entry for step index 0');
  } else {
    fail('findingsPerStep missing entry for step index 0');
  }
};

const assertFidelityResult = (
  result: { failures: unknown[]; findingsPerStep: Map<number, unknown> },
  lines: string[],
): void => {
  if (lines.some(l => l.includes(`[${CLI_BACKEND_LABEL}]`))) {
    pass('fidelity call routed through CLI backend');
  } else {
    fail('fidelity call did not route through CLI backend', lines.join(' | ') || '(none)');
  }
  assertFidelityContent(result);
};

const callVerifyAll = (service: StepSpecFidelityService, repoDir: string) =>
  service.verifyAll(
    [{ index: 0, text: 'Update src/foo.ts to export a named constant' }],
    repoDir,
    'HEAD',
    { assessorProvider: 'anthropic', assessorModel: 'claude-haiku-4-5-20251001', assessorBackend: 'cli' },
  );

const runFidelityWithCliBackend = async (repoDir: string): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(StepSpecFidelityService);
    const { lines, restore } = interceptConsole();
    const result = await callVerifyAll(service, repoDir).finally(restore);
    assertFidelityResult(result, lines);
  } finally {
    await app.close();
  }
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  planStepVerification backend fidelity routing smoke test\n'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fidelity-backend-'));
  try {
    initRepo(repoDir);
    await runFidelityWithCliBackend(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
