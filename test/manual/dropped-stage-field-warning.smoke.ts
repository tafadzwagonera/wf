/**
 * Manual smoke test: dropped-field audit warns at bootstrap for validated-but-uncarried fields
 *
 * Run: nr test:manual dropped-stage-field-warning.smoke
 *
 * Verifies:
 *   1. initializeWfConfig succeeds with stages.generate.skills (a drop, not a rejection)
 *   2. console.warn fired once naming stages.generate.skills and "will be ignored"
 *   3. The agent log gained a WARN wf-config entry for the dropped field
 *   4. ConfigService.get('stages.generate.skills') returns undefined (the drop is real)
 *   5. Negative: a fully-carried config emits no warning and no WARN log line
 *   6. Intentional drop: implement.model alongside models strips silently, no warning
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function makeTempConfig(prefix: string, stagesLines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const content = [
    'export default {',
    "  ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key', default: true }],",
    '  stages: {',
    ...stagesLines,
    '  },',
    '};',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'wf.config.ts'), content, 'utf-8');
  return dir;
}

function readAgentLogFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(os.homedir(), '.wf', 'logs', `agent-${today}.log`);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
}

const interceptConsoleWarn = (): { captured: string[]; restore: () => void } => {
  const captured: string[] = [];
  const boundConsoleWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
    boundConsoleWarn(...args);
  };
  const restore = (): void => {
    console.warn = boundConsoleWarn;
  };
  return { captured, restore };
};

const configAuditWarnings = (captured: string[]): string[] =>
  captured.filter(line => line.includes('wf config:'));

async function loadAndObserve(dir: string): Promise<{ warnings: string[]; newLogEntries: string }> {
  const logBefore = readAgentLogFile();
  const { captured, restore } = interceptConsoleWarn();
  await initializeWfConfig(dir);
  restore();
  return { warnings: configAuditWarnings(captured), newLogEntries: readAgentLogFile().slice(logBefore.length) };
}

async function checkDroppedFieldWarns(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: stages.generate.skills validates but is dropped\n'));
  const dir = makeTempConfig('wf-dropped-field-', ["    generate: { provider: 'anthropic', skills: ['writing-plans'] },"]);
  tempDirs.push(dir);
  const { warnings, newLogEntries } = await loadAndObserve(dir);
  assert('initializeWfConfig succeeds (drop, not rejection)', true);
  assert('console.warn fired exactly once for the audit', warnings.length === 1, `got ${warnings.length}: ${warnings.join(' | ')}`);
  assert('warning names stages.generate.skills', warnings.every(w => w.includes('stages.generate.skills')));
  assert('warning says the field will be ignored', warnings.every(w => w.includes('will be ignored')));
  assert('agent log gained WARN wf-config dropped-fields entry', newLogEntries.includes('[WARN] [wf-config] config.normalize dropped-fields stages.generate.skills'));
  await assertDropIsReal(dir);
}

async function assertDropIsReal(dir: string): Promise<void> {
  await initializeWfConfig(dir);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const skills = app.get(ConfigService).get<string[]>('stages.generate.skills');
    assert('ConfigService.get(stages.generate.skills) returns undefined', skills === undefined, `got: ${JSON.stringify(skills)}`);
  } finally {
    await app.close();
  }
}

async function checkCarriedConfigStaysQuiet(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: fully-carried config emits no warning\n'));
  const dir = makeTempConfig('wf-carried-field-', ["    implement: { provider: 'anthropic', skills: ['coding-style'], figma: true },"]);
  tempDirs.push(dir);
  const { warnings, newLogEntries } = await loadAndObserve(dir);
  assert('no audit warning for fully-carried config', warnings.length === 0, warnings.join(' | '));
  assert('no dropped-fields WARN appended to agent log', newLogEntries.includes('dropped-fields') === false);
}

async function checkIntentionalModelStripStaysQuiet(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: intentional implement model strip emits no warning\n'));
  const dir = makeTempConfig('wf-intentional-drop-', [
    "    implement: { provider: 'anthropic', model: 'claude-sonnet-4-6', models: { mechanical: 'claude-haiku-4-5-20251001' } },",
  ]);
  tempDirs.push(dir);
  const { warnings } = await loadAndObserve(dir);
  assert('no audit warning for the deliberate model strip', warnings.length === 0, warnings.join(' | '));
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Dropped stage field warning smoke test\n'));
  const tempDirs: string[] = [];
  try {
    await checkDroppedFieldWarns(tempDirs);
    await checkCarriedConfigStaysQuiet(tempDirs);
    await checkIntentionalModelStripStaysQuiet(tempDirs);
  } finally {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
