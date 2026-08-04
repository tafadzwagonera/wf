/**
 * Manual smoke test: provider intent detection with stage-level overrides
 *
 * Run: nr test:manual -- test-provider-intent-stage-override
 *
 * Verifies:
 *   1. Default provider warns when context files are missing
 *   2. Non-default provider without stage override does NOT warn
 *   3. Non-default provider with matching stage override DOES warn
 *   4. Implicit first-entry default (no default: true) warns
 *   5. extractStageProviders handles undefined stage values without crashing
 *   6. extractStageProviders correctly extracts provider names from mixed stages
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnthropicAdapter } from '../../src/integrations/ai/adapters/anthropic.adapter';
import { OpenAIAdapter } from '../../src/integrations/ai/adapters/openai.adapter';
import { DeepSeekAdapter } from '../../src/integrations/ai/adapters/deepseek.adapter';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { hasProviderUsageIntent, extractStageProviders } from '../../src/integrations/ai/adapters/provider-intent';
import type { WfAiProviderConfig, WfAiProviderName } from '../../src/config/public-config';

const tempHomePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-provider-intent-'));
const projectClaudePath = path.join(process.cwd(), 'CLAUDE.md');
const projectOpenaiPath = path.join(process.cwd(), 'AGENTS.md');
const projectDeepseekPath = path.join(process.cwd(), 'DEEPSEEK.md');

type BackupEntry = { path: string; existed: boolean; content?: string };

const backupFile = (filePath: string): BackupEntry => {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, existed: false };
  }
  return { path: filePath, existed: true, content: fs.readFileSync(filePath, 'utf-8') };
};

const restoreFile = ({ path: filePath, existed, content }: BackupEntry): void => {
  if (!existed) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content ?? '', 'utf-8');
};

const removeIfPresent = (filePath: string): void => {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
};

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(`  \x1b[31m✗\x1b[0m ${message}`);
  if (detail) console.log(`    ${detail}`);
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }

  fail(label, detail);
};

function captureConsoleWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const originalWarn = console.warn;

  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };

  return {
    messages,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

function createMockConfigService(
  providers: Array<Record<string, unknown>>,
  stages?: Record<string, unknown>,
): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'ai.providers': providers,
        'ai.anthropicApiKey': providers.find(p => p.provider === 'anthropic')?.apiKey,
        'ai.openaiApiKey': providers.find(p => p.provider === 'openai')?.apiKey,
        'ai.deepseekApiKey': providers.find(p => p.provider === 'deepseek')?.apiKey,
        'ai.geminiApiKey': undefined,
        'ai.model': providers.find(p => p.default)?.model ?? providers[0]?.model,
        stages,
      };

      return key in values ? values[key] : defaultValue;
    },
  } as ConfigService;
}

const mockLogger = {
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  log: () => undefined,
} as unknown as LoggerService;

async function testDefaultProviderWarns(): Promise<void> {
  console.log('\n  Scenario: default provider warns when context files are missing');

  const spy = captureConsoleWarn();
  const originalHome = process.env.HOME;
  const backups = [backupFile(projectClaudePath)];

  try {
    process.env.HOME = tempHomePath;
    removeIfPresent(projectClaudePath);

    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-20250514', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];

    const configService = createMockConfigService(providers);
    await new AnthropicAdapter(configService, mockLogger).onModuleInit();

    const output = spy.messages.join('\n');
    assert(
      'Anthropic (default: true) warns about missing context files',
      output.includes('No global or project-level configuration found for anthropic'),
      `captured: ${output || '(nothing)'}`,
    );
  } finally {
    spy.restore();
    process.env.HOME = originalHome;
    for (const backup of backups.reverse()) restoreFile(backup);
  }
}

async function testNonDefaultWithoutStageOverrideDoesNotWarn(): Promise<void> {
  console.log('\n  Scenario: non-default provider without stage override does NOT warn');

  const spy = captureConsoleWarn();
  const originalHome = process.env.HOME;
  const backups = [backupFile(projectOpenaiPath)];

  try {
    process.env.HOME = tempHomePath;
    removeIfPresent(projectOpenaiPath);

    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-20250514', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];

    const configService = createMockConfigService(providers);
    await new OpenAIAdapter(configService, mockLogger).onModuleInit();

    const output = spy.messages.join('\n');
    assert(
      'OpenAI (non-default, no stage override) does not warn',
      !output.includes('No global or project-level configuration found for openai'),
      `captured: ${output || '(nothing)'}`,
    );
  } finally {
    spy.restore();
    process.env.HOME = originalHome;
    for (const backup of backups.reverse()) restoreFile(backup);
  }
}

async function testNonDefaultWithStageOverrideWarns(): Promise<void> {
  console.log('\n  Scenario: non-default provider with stage override DOES warn');

  const spy = captureConsoleWarn();
  const originalHome = process.env.HOME;
  const backups = [backupFile(projectOpenaiPath)];

  try {
    process.env.HOME = tempHomePath;
    removeIfPresent(projectOpenaiPath);

    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-20250514', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];
    const stages = {
      review: { provider: 'openai', model: 'gpt-4.1', backend: 'standard' },
    };

    const configService = createMockConfigService(providers, stages);
    await new OpenAIAdapter(configService, mockLogger).onModuleInit();

    const output = spy.messages.join('\n');
    assert(
      'OpenAI (non-default, stage override for review) warns about missing context files',
      output.includes('No global or project-level configuration found for openai'),
      `captured: ${output || '(nothing)'}`,
    );
  } finally {
    spy.restore();
    process.env.HOME = originalHome;
    for (const backup of backups.reverse()) restoreFile(backup);
  }
}

async function testImplicitFirstEntryDefault(): Promise<void> {
  console.log('\n  Scenario: implicit first-entry default warns');

  const spy = captureConsoleWarn();
  const originalHome = process.env.HOME;
  const backups = [backupFile(projectDeepseekPath)];

  try {
    process.env.HOME = tempHomePath;
    removeIfPresent(projectDeepseekPath);

    const providers = [
      { provider: 'deepseek', apiKey: 'sk-ds-xxx', model: 'deepseek-reasoner' },
    ];

    const configService = createMockConfigService(providers);
    await new DeepSeekAdapter(configService, mockLogger).onModuleInit();

    const output = spy.messages.join('\n');
    assert(
      'DeepSeek (implicit first-entry default) warns about missing context files',
      output.includes('No global or project-level configuration found for deepseek'),
      `captured: ${output || '(nothing)'}`,
    );
  } finally {
    spy.restore();
    process.env.HOME = originalHome;
    for (const backup of backups.reverse()) restoreFile(backup);
  }
}

function testExtractStageProvidersWithUndefinedValues(): void {
  console.log('\n  Scenario: extractStageProviders handles undefined stage values');

  const stages = {
    plan: undefined,
    review: { provider: 'openai' as WfAiProviderName, model: 'gpt-4.1', backend: 'standard' as const },
    implement: undefined,
    commit: undefined,
  };

  let result: (WfAiProviderName | undefined)[];
  try {
    result = extractStageProviders(stages);
    assert(
      'extractStageProviders does not throw on undefined stage values',
      true,
    );
  } catch (error) {
    fail(
      'extractStageProviders threw on undefined stage values',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  assert(
    'extractStageProviders returns correct provider names for mixed stages',
    result.length === 4
    && result[0] === undefined
    && result[1] === 'openai'
    && result[2] === undefined
    && result[3] === undefined,
    `got: [${result.join(', ')}]`,
  );
}

function testHasProviderUsageIntentWithStageProviders(): void {
  console.log('\n  Scenario: hasProviderUsageIntent respects stageProviders');

  const providers: WfAiProviderConfig[] = [
    { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6', default: true },
    { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
  ];

  assert(
    'default provider returns true without stageProviders',
    hasProviderUsageIntent(providers, 'anthropic') === true,
  );

  assert(
    'non-default provider returns false without stageProviders',
    hasProviderUsageIntent(providers, 'openai') === false,
  );

  assert(
    'non-default provider returns true when in stageProviders',
    hasProviderUsageIntent(providers, 'openai', ['openai']) === true,
  );

  assert(
    'non-default provider returns false when stageProviders has different provider',
    hasProviderUsageIntent(providers, 'openai', ['google']) === false,
  );

  const fullyOverriddenProviders: WfAiProviderConfig[] = [
    { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6' },
    { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: true },
  ];

  assert(
    'explicit default returns false when every stage overrides to a different provider',
    hasProviderUsageIntent(fullyOverriddenProviders, 'openai', ['anthropic', 'anthropic', 'anthropic']) === false,
  );

  assert(
    'explicit default returns true when at least one stage has no override',
    hasProviderUsageIntent(fullyOverriddenProviders, 'openai', ['anthropic', undefined, 'anthropic']) === true,
  );
}

async function main(): Promise<void> {
  console.log('\nProvider intent detection with stage-level overrides\n');

  testExtractStageProvidersWithUndefinedValues();
  testHasProviderUsageIntentWithStageProviders();
  await testDefaultProviderWarns();
  await testNonDefaultWithoutStageOverrideDoesNotWarn();
  await testNonDefaultWithStageOverrideWarns();
  await testImplicitFirstEntryDefault();

  fs.rmSync(tempHomePath, { recursive: true, force: true });

  console.log(`\n  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
