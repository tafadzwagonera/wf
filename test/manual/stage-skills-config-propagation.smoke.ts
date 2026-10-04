/**
 * Manual smoke test: stage skills survive config normalization into live skill loading
 *
 * Run: nr test:manual stage-skills-config-propagation.smoke
 *
 * Verifies:
 *   1. initializeWfConfig succeeds with skills on plan and implement stages
 *   2. ConfigService.get('stages.plan.skills') returns the configured array
 *   3. ConfigService.get('stages.implement.skills') returns the configured array
 *   4. resolveSkills resolves the ConfigService-sourced ids for each stage without throwing
 *   5. buildSkillPromptFragment fed the ConfigService-sourced ids prints one
 *      "[claude-cli] Skill('<id>') loaded" line per skill to stdout
 *   6. The on-disk agent log gains one INFO entry per skill after the call
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { buildSkillPromptFragment, resolveSkills } from '../../src/skills';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

const planSkills = ['test-driven-development', 'writing-plans'];
const implementSkills = ['coding-style', 'test-driven-development'];
const backendLabel = 'claude-cli';

function makeTempConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skills-propagation-'));
  const content = [
    'export default {',
    "  ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key', default: true }],",
    '  stages: {',
    `    plan: { provider: 'anthropic', backend: 'cli', skills: ${JSON.stringify(planSkills)} },`,
    `    implement: { provider: 'anthropic', backend: 'cli', skills: ${JSON.stringify(implementSkills)} },`,
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

const interceptConsoleLog = (): { captured: string[]; restore: () => void } => {
  const captured: string[] = [];
  const boundConsoleLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
    boundConsoleLog(...args);
  };
  const restore = (): void => {
    console.log = boundConsoleLog;
  };
  return { captured, restore };
};

function assertConfigReads(configService: ConfigService): { planIds: string[]; implementIds: string[] } {
  const planIds = configService.get<string[]>('stages.plan.skills') ?? [];
  const implementIds = configService.get<string[]>('stages.implement.skills') ?? [];
  assert('ConfigService resolves stages.plan.skills', JSON.stringify(planIds) === JSON.stringify(planSkills), `got: ${JSON.stringify(planIds)}`);
  assert('ConfigService resolves stages.implement.skills', JSON.stringify(implementIds) === JSON.stringify(implementSkills), `got: ${JSON.stringify(implementIds)}`);
  return { planIds, implementIds };
}

async function assertRegistryResolution(planIds: string[], implementIds: string[]): Promise<void> {
  const planResolved = await resolveSkills(planIds, { interactive: false, stage: 'plan' });
  assert('resolveSkills resolves all plan skills', planResolved.length === planIds.length, `resolved: ${planResolved.map(s => s.id).join(', ')}`);
  const implementResolved = await resolveSkills(implementIds, { interactive: false, stage: 'implement' });
  assert('resolveSkills resolves all implement skills', implementResolved.length === implementIds.length, `resolved: ${implementResolved.map(s => s.id).join(', ')}`);
}

async function assertLiveObservability(implementIds: string[]): Promise<void> {
  const logBefore = readAgentLogFile();
  const { captured, restore } = interceptConsoleLog();
  const fragment = await buildSkillPromptFragment(implementIds, backendLabel, chalk.gray);
  restore();
  const newLogEntries = readAgentLogFile().slice(logBefore.length);
  assert('fragment contains one section per configured skill', implementIds.every(id => fragment.includes(`## Skill: ${id}`)));
  for (const id of implementIds) {
    assert(`stdout contains [${backendLabel}] Skill('${id}') loaded`, captured.some(l => l.includes(`[${backendLabel}] Skill('${id}') loaded`)));
    assert(`agent log gained INFO entry for ${id}`, newLogEntries.includes(`Skill('${id}') loaded`));
  }
}

async function bootstrapWith(dir: string): Promise<Awaited<ReturnType<typeof NestFactory.createApplicationContext>>> {
  await initializeWfConfig(dir);
  assert('initializeWfConfig succeeds with skills configured', true);
  return NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Stage skills config propagation smoke test\n'));
  const dir = makeTempConfig();
  const app = await bootstrapWith(dir);
  try {
    const { planIds, implementIds } = assertConfigReads(app.get(ConfigService));
    await assertRegistryResolution(planIds, implementIds);
    await assertLiveObservability(implementIds);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
