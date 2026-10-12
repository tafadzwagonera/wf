/**
 * Manual smoke test: unsupported stage skills are rejected and the dropped-field audit stays quiet otherwise
 *
 * Run: nr test:manual dropped-stage-field-warning.smoke
 *
 * Verifies:
 *   1. initializeWfConfig rejects stages.generate.skills with an error naming the field
 *   2. Negative: a fully-carried config emits no warning and no WARN log line
 *   3. Intentional drop: implement.model alongside models strips silently, no warning
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
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

async function checkUnsupportedSkillsRejected(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: stages.generate.skills is rejected at load\n'));
  const dir = makeTempConfig('wf-rejected-field-', ["    generate: { provider: 'anthropic', skills: ['writing-plans'] },"]);
  tempDirs.push(dir);
  const error = await initializeWfConfig(dir).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert('initializeWfConfig rejects the config', error instanceof Error);
  assert(
    'error names stages.generate.skills',
    error instanceof Error && error.message.includes('stages.generate.skills'),
    String(error),
  );
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
    await checkUnsupportedSkillsRejected(tempDirs);
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
