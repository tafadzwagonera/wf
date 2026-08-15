/**
 * Manual smoke test: implement stage timeoutMs accepted through full app bootstrap
 *
 * Run: nr test:manual -- test-implement-timeout-config-bootstrap
 *
 * Verifies:
 *   1. initializeWfConfig succeeds with stages.implement.timeoutMs set
 *   2. ConfigService.get('stages.implement.timeoutMs') returns the configured value
 *   3. ConfigService.get('stages.implement.inactivityTimeoutMs') returns the configured value
 *   4. Omitting both fields: ConfigService returns undefined (runtime falls back to defaults)
 *   5. Both timeouts coexist with other implement stage fields (verificationConditions)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  ✓ ${message}`);
  passed++;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function makeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-timeout-bootstrap-'));
  fs.writeFileSync(path.join(dir, 'wf.config.ts'), content, 'utf-8');
  return dir;
}

async function bootstrapWith(configDir: string) {
  await initializeWfConfig(configDir);
  return NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
}

async function main() {
  console.log('\nImplement stage timeout config bootstrap smoke test\n' + '─'.repeat(60));

  const tempDirs: string[] = [];

  {
    console.log('\n  Scenario: both timeouts configured\n');
    const dir = makeTempConfig(
      [
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
      ].join('\n')
    );
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

  {
    console.log('\n  Scenario: timeouts omitted (defaults apply)\n');
    const dir = makeTempConfig(
      [
        'export default {',
        "  ai: [{ provider: 'anthropic', apiKey: 'test-key', default: true }],",
        '  stages: {',
        '    implement: {',
        "      provider: 'anthropic',",
        '    },',
        '  },',
        '};',
      ].join('\n')
    );
    tempDirs.push(dir);

    const app = await bootstrapWith(dir);
    const configService = app.get(ConfigService);

    const omittedTimeout = configService.get<number>('stages.implement.timeoutMs');
    const omittedInactivity = configService.get<number>('stages.implement.inactivityTimeoutMs');
    assert('omitting timeoutMs: ConfigService returns undefined', omittedTimeout === undefined, `got: ${omittedTimeout}`);
    assert('omitting inactivityTimeoutMs: ConfigService returns undefined', omittedInactivity === undefined, `got: ${omittedInactivity}`);

    await app.close();
  }

  {
    console.log('\n  Scenario: timeouts alongside verificationConditions\n');
    const dir = makeTempConfig(
      [
        'export default {',
        "  ai: [{ provider: 'anthropic', apiKey: 'test-key', default: true }],",
        '  stages: {',
        '    implement: {',
        "      provider: 'anthropic',",
        '      timeoutMs: 1800000,',
        '      inactivityTimeoutMs: 600000,',
        '      verificationConditions: {',
        "        scripts: { lint: 'yarn lint' },",
        '      },',
        '    },',
        '  },',
        '};',
      ].join('\n')
    );
    tempDirs.push(dir);

    const app = await bootstrapWith(dir);
    const configService = app.get(ConfigService);

    const coexistTimeout = configService.get<number>('stages.implement.timeoutMs');
    const coexistInactivity = configService.get<number>('stages.implement.inactivityTimeoutMs');
    const vcScripts = configService.get<Record<string, string>>('stages.implement.verificationConditions.scripts');
    assert(
      'timeoutMs coexists with verificationConditions',
      coexistTimeout === 1800000 && coexistInactivity === 600000 && vcScripts?.lint === 'yarn lint',
      `timeout=${coexistTimeout}, inactivity=${coexistInactivity}, scripts=${JSON.stringify(vcScripts)}`
    );

    await app.close();
  }

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed + failed} assertions: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
