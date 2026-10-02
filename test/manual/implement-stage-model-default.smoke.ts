/**
 * Smoke test: resolveStageModel returns stages.implement.models.default when set
 *
 * Run: nr test:manual implement-stage-model-default.smoke.ts
 *
 * Verifies:
 *   1. resolveStageModel('implement') returns stages.implement.models.default, not the global provider model
 *   2. resolveStageModel('plan') is unaffected by the implement-stage config
 *   3. resolveStageModel('implement') falls back to the global provider model when models.default is absent
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function patchConfigGet(command: IssueCommand, values: Record<string, unknown>): void {
  const original = (command as any).configService.get.bind((command as any).configService);
  (command as any).configService.get = (key: string, defaultValue?: unknown) =>
    key in values ? values[key] : original(key, defaultValue);
}

function checkImplementReturnsStageDefault(command: IssueCommand): void {
  patchConfigGet(command, {
    'stages.implement.model': undefined,
    'stages.implement.models': { default: 'claude-sonnet-4-6' },
    'ai.providers': [{ provider: 'anthropic', model: 'claude-opus-5' }],
  });
  const model = (command as any).resolveStageModel('implement');
  if (model === 'claude-sonnet-4-6') {
    pass("resolveStageModel('implement') returns 'claude-sonnet-4-6' from stages.implement.models.default");
  } else {
    fail("expected 'claude-sonnet-4-6' from models.default, got: " + String(model));
  }
}

function checkPlanUnaffectedByImplementConfig(command: IssueCommand): void {
  patchConfigGet(command, {
    'stages.implement.models': { default: 'claude-sonnet-4-6' },
    'stages.plan.model': undefined,
    'stages.plan.provider': undefined,
    'ai.provider': 'anthropic',
    'ai.providers': [{ provider: 'anthropic', model: 'claude-opus-5' }],
  });
  const model = (command as any).resolveStageModel('plan');
  if (model === 'claude-opus-5') {
    pass("resolveStageModel('plan') returns global provider model 'claude-opus-5', not the implement models.default");
  } else {
    fail("expected 'claude-opus-5' for plan stage, got: " + String(model));
  }
}

function checkImplementFallsBackWhenModelsAbsent(command: IssueCommand): void {
  patchConfigGet(command, {
    'stages.implement.model': undefined,
    'stages.implement.models': undefined,
    'stages.implement.provider': undefined,
    'ai.provider': 'anthropic',
    'ai.providers': [{ provider: 'anthropic', model: 'claude-opus-5' }],
  });
  const model = (command as any).resolveStageModel('implement');
  if (model === 'claude-opus-5') {
    pass("resolveStageModel('implement') falls back to global provider model when stages.implement.models is absent");
  } else {
    fail("expected 'claude-opus-5' fallback when models absent, got: " + String(model));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: implement stage resolves models.default from config\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    checkImplementReturnsStageDefault(command);
    checkPlanUnaffectedByImplementConfig(command);
    checkImplementFallsBackWhenModelsAbsent(command);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(chalk.red(`\nFAILED: ${error.message}\n`));
  process.exit(1);
});
