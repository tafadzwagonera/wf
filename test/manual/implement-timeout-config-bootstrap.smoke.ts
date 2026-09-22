/**
 * Manual smoke test: implement stage timeoutMs accepted through full app bootstrap
 *
 * Run: nr test:manual implement-timeout-config-bootstrap.smoke.ts
 *
 * Verifies:
 *   1. initializeWfConfig succeeds with stages.implement.timeoutMs set
 *   2. ConfigService.get('stages.implement.timeoutMs') returns the configured value
 *   3. ConfigService.get('stages.implement.inactivityTimeoutMs') returns the configured value
 *   4. Omitting both fields: ConfigService returns undefined (runtime falls back to defaults)
 *   5. Both timeouts coexist with other implement stage fields (verificationConditions)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function makeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-timeout-bootstrap-'));
  fs.writeFileSync(path.join(dir, 'wf.config.ts'), content, 'utf-8');
  return dir;
}

async function bootstrapWith(
  configDir: string
): Promise<Awaited<ReturnType<typeof NestFactory.createApplicationContext>>> {
  await initializeWfConfig(configDir);
  return NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
}

function scenarioBothTimeoutsConfig(): string {
  return [
    'export default {',
    "  ai: [{ provider: 'anthropic', apiKey: 'test-key', default: true }],",
    '  stages: {',
    '    implement: {',
    "      provider: 'anthropic',",
    '      timeoutMs: 1200000,',
    '      inactivityTimeoutMs: 300000,',
    '    },',
    '  },',
    '};',
  ].join('\n');
}

async function checkBothTimeoutsConfigured(tempDirs: string[]): Promise<void> {
  console.log('\n  Scenario: both timeouts configured\n');
  const dir = makeTempConfig(scenarioBothTimeoutsConfig());
  tempDirs.push(dir);
  const app = await bootstrapWith(dir);
  const configService = app.get(ConfigService);
  assert('initializeWfConfig succeeds with timeoutMs set', true);
  const timeoutMs = configService.get<number>('stages.implement.timeoutMs');
  assert('ConfigService resolves stages.implement.timeoutMs = 1200000', timeoutMs === 1200000, `got: ${timeoutMs}`);
  const inactivityTimeoutMs = configService.get<number>('stages.implement.inactivityTimeoutMs');
  assert('ConfigService resolves stages.implement.inactivityTimeoutMs = 300000', inactivityTimeoutMs === 300000, `got: ${inactivityTimeoutMs}`);
  await app.close();
}

function scenarioTimeoutsOmittedConfig(): string {
  return [
    'export default {',
    "  ai: [{ provider: 'anthropic', apiKey: 'test-key', default: true }],",
    '  stages: {',
    '    implement: {',
    "      provider: 'anthropic',",
    '    },',
    '  },',
    '};',
  ].join('\n');
}

async function checkTimeoutsOmitted(tempDirs: string[]): Promise<void> {
  console.log('\n  Scenario: timeouts omitted (defaults apply)\n');
  const dir = makeTempConfig(scenarioTimeoutsOmittedConfig());
  tempDirs.push(dir);
  const app = await bootstrapWith(dir);
  const configService = app.get(ConfigService);
  const omittedTimeout = configService.get<number>('stages.implement.timeoutMs');
  const omittedInactivity = configService.get<number>('stages.implement.inactivityTimeoutMs');
  assert('omitting timeoutMs: ConfigService returns undefined', omittedTimeout === undefined, `got: ${omittedTimeout}`);
  assert('omitting inactivityTimeoutMs: ConfigService returns undefined', omittedInactivity === undefined, `got: ${omittedInactivity}`);
  await app.close();
}

function scenarioImplementWithVerificationLines(): string[] {
  return [
    '    implement: {',
    "      provider: 'anthropic',",
    '      timeoutMs: 1800000,',
    '      inactivityTimeoutMs: 600000,',
    '      verificationConditions: {',
    "        scripts: { lint: 'yarn lint' },",
    '      },',
    '    },',
  ];
}

function scenarioTimeoutsWithVerificationConfig(): string {
  return [
    'export default {',
    "  ai: [{ provider: 'anthropic', apiKey: 'test-key', default: true }],",
    '  stages: {',
    ...scenarioImplementWithVerificationLines(),
    '  },',
    '};',
  ].join('\n');
}

function readVerificationCoexistValues(configService: ConfigService): {
  coexistTimeout: number | undefined;
  coexistInactivity: number | undefined;
  vcScripts: Record<string, string> | undefined;
} {
  return {
    coexistTimeout: configService.get<number>('stages.implement.timeoutMs'),
    coexistInactivity: configService.get<number>('stages.implement.inactivityTimeoutMs'),
    vcScripts: configService.get<Record<string, string>>('stages.implement.verificationConditions.scripts'),
  };
}

async function checkTimeoutsAlongsideVerification(tempDirs: string[]): Promise<void> {
  console.log('\n  Scenario: timeouts alongside verificationConditions\n');
  const dir = makeTempConfig(scenarioTimeoutsWithVerificationConfig());
  tempDirs.push(dir);
  const app = await bootstrapWith(dir);
  const { coexistTimeout, coexistInactivity, vcScripts } = readVerificationCoexistValues(app.get(ConfigService));
  assert(
    'timeoutMs coexists with verificationConditions',
    coexistTimeout === 1800000 && coexistInactivity === 600000 && vcScripts?.lint === 'yarn lint',
    `timeout=${coexistTimeout}, inactivity=${coexistInactivity}, scripts=${JSON.stringify(vcScripts)}`
  );
  await app.close();
}

async function main(): Promise<void> {
  console.log('\nImplement stage timeout config bootstrap smoke test\n' + '─'.repeat(60));
  const tempDirs: string[] = [];
  await checkBothTimeoutsConfigured(tempDirs);
  await checkTimeoutsOmitted(tempDirs);
  await checkTimeoutsAlongsideVerification(tempDirs);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
