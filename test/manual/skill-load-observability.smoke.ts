/**
 * Manual smoke test: buildSkillPromptFragment emits console.log and log-file entries per skill loaded
 *
 * Run: nr test:manual skill-load-observability.smoke
 *
 * Verifies:
 *   1. buildSkillPromptFragment returns a string containing each requested skill section
 *   2. The returned string begins with '\n\n'
 *   3. stdout captures one '[backend] Skill(id) loaded' line per skill
 *   4. The agent log file gains one entry per skill loaded
 *   5. buildSkillPromptFragment with an empty array returns '' with no stdout output
 *
 * @returns Promise that resolves when the smoke test completes
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { buildSkillPromptFragment } from '../../src/skills/skill-content';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

const BACKEND = 'obs-test';
const SKILL_IDS = ['coding-style', 'writing-plans'];

async function readAgentLogFile(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(os.homedir(), '.wf', 'logs', `agent-${today}.log`);
  try {
    return await fs.readFile(logPath, 'utf-8');
  } catch {
    return '';
  }
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

const assertFragmentSections = (fragment: string): void => {
  assert('fragment contains coding-style section', fragment.includes('## Skill: coding-style'));
  assert('fragment contains writing-plans section', fragment.includes('## Skill: writing-plans'));
  assert('fragment starts with double newline', fragment.startsWith('\n\n'));
};

const assertSkillObservability = (captured: string[], newLogEntries: string): void => {
  for (const id of SKILL_IDS) {
    assert(`stdout contains ${id} loaded`, captured.some(l => l.includes(`Skill('${id}') loaded`)));
    assert(`log file gained ${id} entry`, newLogEntries.includes(`Skill('${id}') loaded`));
  }
};

async function checkFragmentContentAndObservability(): Promise<void> {
  console.log(chalk.bold('Test 1-4: Fragment content and observability side effects'));
  const logBefore = await readAgentLogFile();
  const { captured, restore } = interceptConsoleLog();
  const fragment = await buildSkillPromptFragment(SKILL_IDS, BACKEND, chalk.cyan);
  restore();
  const newLogEntries = (await readAgentLogFile()).slice(logBefore.length);
  assertFragmentSections(fragment);
  assertSkillObservability(captured, newLogEntries);
}

async function checkEmptySkillIdsReturnsEmpty(): Promise<void> {
  console.log(chalk.bold('\nTest 5: Empty skillIds returns empty string'));
  const { captured, restore } = interceptConsoleLog();
  const emptyFragment = await buildSkillPromptFragment([], BACKEND, chalk.cyan);
  restore();
  assert('empty skillIds returns empty string', emptyFragment === '');
  assert('no stdout output for empty skillIds', !captured.some(line => line.includes('Skill(')));
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Skill load observability smoke test\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    await checkFragmentContentAndObservability();
    await checkEmptySkillIdsReturnsEmpty();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
