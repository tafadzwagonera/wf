/**
 * Manual smoke test: figma, sonar, and stallThresholdForVerificationFix survive normalization into stage gates
 *
 * Run: nr test:manual stage-flag-config-propagation.smoke
 *
 * Verifies:
 *   1. initializeWfConfig succeeds with figma/sonar/stallThresholdForVerificationFix set
 *   2. ConfigService resolves stages.{plan,implement,review}.figma = true
 *   3. ConfigService resolves stages.review.sonar = true
 *   4. ConfigService resolves stages.implement.stallThresholdForVerificationFix = 3
 *   5. Live gate: PlanStageService.isFigmaEnabled({}) returns true from config alone
 *   6. Live gate: ClaudeCliAdapter resolves the configured stall cap and stops fix
 *      iterations at it (falls back to STALL_THRESHOLD when omitted)
 *   7. Negative: omitting all five fields yields undefined reads and a false figma gate
 *
 * Sonar behavioral gating (scan runs vs returns early) is covered by
 * src/review/sonar-stage.service.spec.ts; this test covers the config propagation that feeds it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { ClaudeCliAdapter } from '../../src/integrations/ai/adapters/claude-cli.adapter';
import { STALL_THRESHOLD } from '../../src/integrations/ai/adapters/verification-report';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function makeTempConfig(stagesLines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-flag-propagation-'));
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

const flagsEnabledStages = [
  "    plan: { provider: 'anthropic', figma: true },",
  "    implement: { provider: 'anthropic', figma: true, stallThresholdForVerificationFix: 3 },",
  "    review: { provider: 'anthropic', figma: true, sonar: true },",
];

const flagsOmittedStages = [
  "    plan: { provider: 'anthropic' },",
  "    implement: { provider: 'anthropic' },",
  "    review: { provider: 'anthropic' },",
];

function assertEnabledReads(configService: ConfigService): void {
  assert('stages.plan.figma = true', configService.get<boolean>('stages.plan.figma') === true);
  assert('stages.implement.figma = true', configService.get<boolean>('stages.implement.figma') === true);
  assert('stages.review.figma = true', configService.get<boolean>('stages.review.figma') === true);
  assert('stages.review.sonar = true', configService.get<boolean>('stages.review.sonar') === true);
  assert('stages.implement.stallThresholdForVerificationFix = 3', configService.get<number>('stages.implement.stallThresholdForVerificationFix') === 3);
}

function assertOmittedReads(configService: ConfigService): void {
  const keys = [
    'stages.plan.figma', 'stages.implement.figma', 'stages.review.figma',
    'stages.review.sonar', 'stages.implement.stallThresholdForVerificationFix',
  ];
  for (const key of keys) {
    assert(`omitted ${key} reads undefined`, configService.get(key) === undefined, `got: ${configService.get(key)}`);
  }
}

function readFigmaGate(app: { get: (token: typeof PlanStageService) => PlanStageService }): boolean {
  const planStageService = app.get(PlanStageService);
  return (planStageService as unknown as { isFigmaEnabled: (options: object) => boolean }).isFigmaEnabled({});
}

const makeFixState = (readOnly: number): object => ({
  outcomes: [], codeFailures: [{}], sessionId: 's1',
  prevFails: Infinity, stalled: 0, readOnly, passNumber: 1, exhausted: false,
});

function assertStallGate(configService: ConfigService, expectedCap: number): void {
  const adapter = new ClaudeCliAdapter(configService) as unknown as {
    resolveStallThreshold: () => number;
    shouldRunFixIteration: (state: object) => boolean;
  };
  assert(`ClaudeCliAdapter resolves stall cap = ${expectedCap}`, adapter.resolveStallThreshold() === expectedCap, `got: ${adapter.resolveStallThreshold()}`);
  assert('fix iterations keep running below the cap', adapter.shouldRunFixIteration(makeFixState(expectedCap - 1)) === true);
  assert('fix iterations stop at the cap', adapter.shouldRunFixIteration(makeFixState(expectedCap)) === false);
}

async function checkFlagsEnabled(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: all flags enabled via config\n'));
  const dir = makeTempConfig(flagsEnabledStages);
  tempDirs.push(dir);
  await initializeWfConfig(dir);
  assert('initializeWfConfig succeeds with flags configured', true);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    assertEnabledReads(app.get(ConfigService));
    assert('isFigmaEnabled({}) returns true from config alone', readFigmaGate(app) === true);
    assertStallGate(app.get(ConfigService), 3);
  } finally {
    await app.close();
  }
}

async function checkFlagsOmitted(tempDirs: string[]): Promise<void> {
  console.log(chalk.bold('\n  Scenario: all flags omitted\n'));
  const dir = makeTempConfig(flagsOmittedStages);
  tempDirs.push(dir);
  await initializeWfConfig(dir);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    assertOmittedReads(app.get(ConfigService));
    assert('isFigmaEnabled({}) returns false when figma omitted', readFigmaGate(app) === false);
    assertStallGate(app.get(ConfigService), STALL_THRESHOLD);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Stage flag config propagation smoke test\n'));
  const tempDirs: string[] = [];
  try {
    await checkFlagsEnabled(tempDirs);
    await checkFlagsOmitted(tempDirs);
  } finally {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
