import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  countSpawns, readPrompt, runImplement, setupImplementHarness,
  type FakeClaudeMode, type ImplementHarness, type RunResult,
} from './implement-cli-harness';

const ASSESSOR_MARKER = 'Index each step ONLY by its [Plan step N] tag';
const PLANNED_FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

export type StepVerifyRun = {
  harness: ImplementHarness;
  result: RunResult;
  log: string;
  assessorPrompts: string[];
  fixPrompts: string[];
};

const readAgentLog = (harness: ImplementHarness): string => {
  const logDir = path.join(harness.homeDir, '.wf', 'logs');
  return fs.readdirSync(logDir).map(file => fs.readFileSync(path.join(logDir, file), 'utf-8')).join('\n');
};

const collectPrompts = (harness: ImplementHarness): string[] =>
  Array.from({ length: countSpawns(harness) }, (_, i) => readPrompt(harness, i + 1));

export const runStepVerifyScenario = (
  mode: FakeClaudeMode, stepCount: number, stepVerification: Record<string, unknown>,
): StepVerifyRun => {
  const steps = Array.from({ length: stepCount }, (_, i) => `Step ${i}: update src/a.ts`);
  const harness = setupImplementHarness(`wf-step-verify-${mode}-`, mode, PLANNED_FILES, { steps, stepVerification, estimatedComplexity: 'medium' });
  const result = runImplement(harness, 120_000);
  const prompts = collectPrompts(harness);
  return {
    harness,
    result,
    log: readAgentLog(harness),
    assessorPrompts: prompts.filter(prompt => prompt.includes(ASSESSOR_MARKER)),
    fixPrompts: prompts.filter(prompt => prompt.includes('Verification round')),
  };
};

export const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;
