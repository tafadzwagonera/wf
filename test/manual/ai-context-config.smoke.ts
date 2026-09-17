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
import { createReporter } from './support/reporter';

const configPath = path.join(process.cwd(), 'wf.config.js');
const anthropicProjectPath = path.join(process.cwd(), 'CLAUDE.md');
const deepseekProjectPath = path.join(process.cwd(), 'DEEPSEEK.md');
const tempHomePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-ai-context-'));
const anthropicGlobalPath = path.join(tempHomePath, '.claude', 'CLAUDE.md');
const deepseekGlobalPath = path.join(tempHomePath, '.deepseek', 'DEEPSEEK.md');

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

async function main(): Promise<void> {
  console.log('🧪 Testing issue:generate warning gating for AI context files\n');

  const { counts, pass, fail } = createReporter();

  const backups = [backupFile(configPath), backupFile(anthropicProjectPath), backupFile(deepseekProjectPath)];
  const originalHome = process.env.HOME;
  const warnSpy = jestLikeSpy();

  try {
    removeFileIfPresent(anthropicProjectPath);
    removeFileIfPresent(deepseekProjectPath);
    removeFileIfPresent(anthropicGlobalPath);
    removeFileIfPresent(deepseekGlobalPath);

    fs.writeFileSync(
      configPath,
      [
        'module.exports = {',
        '  ai: [',
        '    { provider: "anthropic", apiKey: "anthropic-test-key", model: "claude-sonnet-4-20250514", default: true },',
        '    { provider: "openai", apiKey: "openai-test-key" },',
        '    { provider: "deepseek", apiKey: "deepseek-test-key", model: "deepseek-reasoner" },',
        '  ],',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    process.env.HOME = tempHomePath;
    const providers = [
      {
        provider: 'anthropic',
        apiKey: 'anthropic-test-key',
        model: 'claude-sonnet-4-20250514',
        default: true,
      },
      {
        provider: 'openai',
        apiKey: 'openai-test-key',
      },
      {
        provider: 'deepseek',
        apiKey: 'deepseek-test-key',
        model: 'deepseek-reasoner',
      },
    ];

    const mockConfigService = {
      get: (key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'ai.providers': providers,
          'ai.anthropicApiKey': 'anthropic-test-key',
          'ai.openaiApiKey': 'openai-test-key',
          'ai.geminiApiKey': undefined,
          'ai.deepseekApiKey': 'deepseek-test-key',
          'ai.model': 'claude-sonnet-4-20250514',
        };

        return key in values ? values[key] : defaultValue;
      },
    } as ConfigService;
    const mockLogger = {
      debug: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      log: () => undefined,
    } as unknown as LoggerService;

    await new AnthropicAdapter(mockConfigService, mockLogger).onModuleInit();
    await new OpenAIAdapter(mockConfigService, mockLogger).onModuleInit();
    await new GeminiAdapter(mockConfigService, mockLogger).onModuleInit();
    await new DeepSeekAdapter(mockConfigService, mockLogger).onModuleInit();

    const output = warnSpy.messages.join('\n');

    if (output.includes('No anthropic context file found (looked for')) {
      pass('Anthropic warns when usage intent exists and context files are missing');
    } else {
      fail('Anthropic warning missing', output || '(no warnings captured)');
    }

    if (output.includes('No deepseek context file found')) {
      fail('DeepSeek warning should be suppressed for non-default provider without stage overrides', output || '(no warnings captured)');
    } else {
      pass('DeepSeek does not warn when it is a non-default provider without stage overrides');
    }

    if (output.includes('No openai context file found')) {
      fail('OpenAI warning should be suppressed when model is missing', output || '(no warnings captured)');
    } else {
      pass('OpenAI does not warn when provider intent is incomplete');
    }
  } finally {
    warnSpy.restore();
    process.env.HOME = originalHome;

    for (const backup of backups.reverse()) {
      restoreFile(backup);
    }

    fs.rmSync(tempHomePath, { recursive: true, force: true });
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

function jestLikeSpy(): {
  messages: string[];
  restore: () => void;
} {
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
