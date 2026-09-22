/**
 * Manual Test: AI adapter context warning gating on application startup
 *
 * Run: yarn test:manual test-ai-context-config
 *
 * Verifies that:
 *   1. The default provider warns when global and project context files are
 *      missing during app initialization
 *   2. Non-default providers without stage overrides do not warn
 *   3. Providers without full config (no model) do not warn
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnthropicAdapter } from '../../src/integrations/ai/adapters/anthropic.adapter';
import { OpenAIAdapter } from '../../src/integrations/ai/adapters/openai.adapter';
import { GeminiAdapter } from '../../src/integrations/ai/adapters/gemini.adapter';
import { DeepSeekAdapter } from '../../src/integrations/ai/adapters/deepseek.adapter';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { createReporter, summarise } from './support/reporter';

const configPath = path.join(process.cwd(), 'wf.config.js');
const anthropicProjectPath = path.join(process.cwd(), 'CLAUDE.md');
const deepseekProjectPath = path.join(process.cwd(), 'DEEPSEEK.md');
const tempHomePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-ai-context-'));
const anthropicGlobalPath = path.join(tempHomePath, '.claude', 'CLAUDE.md');
const deepseekGlobalPath = path.join(tempHomePath, '.deepseek', 'DEEPSEEK.md');

const { counts, pass, fail } = createReporter();

type BackupEntry = {
  path: string;
  existed: boolean;
  content?: string;
};

const backupFile = (filePath: string): BackupEntry => {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, existed: false };
  }

  return {
    path: filePath,
    existed: true,
    content: fs.readFileSync(filePath, 'utf-8'),
  };
};

const removeFileIfPresent = (filePath: string): void => {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
};

const restoreFile = ({ path: filePath, existed, content }: BackupEntry): void => {
  if (!existed) {
    fs.rmSync(filePath, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content ?? '', 'utf-8');
};

const PROVIDERS = [
  { provider: 'anthropic', apiKey: 'anthropic-test-key', model: 'claude-sonnet-4-20250514', default: true },
  { provider: 'openai', apiKey: 'openai-test-key' },
  { provider: 'deepseek', apiKey: 'deepseek-test-key', model: 'deepseek-reasoner' },
];

const TEST_CONFIG = [
  'module.exports = {',
  '  ai: [',
  '    { provider: "anthropic", apiKey: "anthropic-test-key", model: "claude-sonnet-4-20250514", default: true },',
  '    { provider: "openai", apiKey: "openai-test-key" },',
  '    { provider: "deepseek", apiKey: "deepseek-test-key", model: "deepseek-reasoner" },',
  '  ],',
  '};',
  '',
].join('\n');

function buildMockConfigService(): ConfigService {
  const values: Record<string, unknown> = {
    'ai.providers': PROVIDERS,
    'ai.anthropicApiKey': 'anthropic-test-key',
    'ai.openaiApiKey': 'openai-test-key',
    'ai.geminiApiKey': undefined,
    'ai.deepseekApiKey': 'deepseek-test-key',
    'ai.model': 'claude-sonnet-4-20250514',
  };
  return { get: (key: string, defaultValue?: unknown) => key in values ? values[key] : defaultValue } as ConfigService;
}

function buildMockLogger(): LoggerService {
  return {
    debug: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as LoggerService;
}

function prepareFilesystem(): BackupEntry[] {
  const backups = [backupFile(configPath), backupFile(anthropicProjectPath), backupFile(deepseekProjectPath)];
  removeFileIfPresent(anthropicProjectPath);
  removeFileIfPresent(deepseekProjectPath);
  removeFileIfPresent(anthropicGlobalPath);
  removeFileIfPresent(deepseekGlobalPath);
  fs.writeFileSync(configPath, TEST_CONFIG, 'utf-8');
  return backups;
}

function restoreFilesystem(originalHome: string | undefined, backups: BackupEntry[]): void {
  process.env.HOME = originalHome;
  for (const backup of backups.reverse()) restoreFile(backup);
  fs.rmSync(tempHomePath, { recursive: true, force: true });
}

async function runAdaptersAndCaptureWarnings(
  mockConfigService: ConfigService,
  mockLogger: LoggerService,
): Promise<string> {
  const warnSpy = jestLikeSpy();
  try {
    await new AnthropicAdapter(mockConfigService, mockLogger).onModuleInit();
    await new OpenAIAdapter(mockConfigService, mockLogger).onModuleInit();
    await new GeminiAdapter(mockConfigService, mockLogger).onModuleInit();
    await new DeepSeekAdapter(mockConfigService, mockLogger).onModuleInit();
    return warnSpy.messages.join('\n');
  } finally {
    warnSpy.restore();
  }
}

function checkAnthropicWarns(output: string): void {
  if (output.includes('No anthropic context file found (looked for')) {
    pass('Anthropic warns when usage intent exists and context files are missing');
  } else {
    fail('Anthropic warning missing', output || '(no warnings captured)');
  }
}

function checkDeepSeekSilent(output: string): void {
  if (!output.includes('No deepseek context file found')) {
    pass('DeepSeek does not warn when it is a non-default provider without stage overrides');
  } else {
    fail('DeepSeek warning should be suppressed for non-default provider without stage overrides', output || '(no warnings captured)');
  }
}

function checkOpenAISilent(output: string): void {
  if (!output.includes('No openai context file found')) {
    pass('OpenAI does not warn when provider intent is incomplete');
  } else {
    fail('OpenAI warning should be suppressed when model is missing', output || '(no warnings captured)');
  }
}

async function main(): Promise<void> {
  console.log('🧪 Testing issue:generate warning gating for AI context files\n');
  const backups = prepareFilesystem();
  const originalHome = process.env.HOME;
  process.env.HOME = tempHomePath;
  try {
    const output = await runAdaptersAndCaptureWarnings(buildMockConfigService(), buildMockLogger());
    checkAnthropicWarns(output);
    checkDeepSeekSilent(output);
    checkOpenAISilent(output);
  } finally {
    restoreFilesystem(originalHome, backups);
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

const captureWarning = (messages: string[]) => (...args: unknown[]) => {
  messages.push(args.map(String).join(' '));
};

function jestLikeSpy(): {
  messages: string[];
  restore: () => void;
} {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = captureWarning(messages);
  return {
    messages,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}
