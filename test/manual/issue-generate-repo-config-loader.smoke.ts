/**
 * Manual Test: issue:generate repo-scoped wf.config.js loading in ESM repos
 *
 * Run: nr test:manual -- test-issue-generate-repo-config-loader
 *
 * Verifies that:
 *   1. CLI bootstrap can target a local repo passed via `--repos`
 *   2. An ESM repo using `module.exports` in `wf.config.js` loads authored AI config
 *   3. `issue:generate` reaches AI synthesis instead of falling back to default config
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { resolveConfigCwd } from '../../src/bootstrap/resolve-config-cwd';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

const MOCK_AI_RESPONSE = [
  '# Repo Scoped Title',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  '',
  '### Summary',
  'Repo-scoped config loaded successfully.',
  '',
  '#### Technical Details',
  'None',
  '',
  '### Acceptance Criteria',
  '- None',
  '',
  '### Risks & Assumptions',
  '- None',
  '',
  '#### Out of Scope',
  '- None',
  '',
].join('\n');

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: issue:generate repo-scoped wf.config.js loading in ESM repos\n');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-repo-config-loader-'));
  const repoRoot = path.join(tempRoot, 'repo-scoped-esm-app');
  fs.mkdirSync(repoRoot, { recursive: true });

  const sourceFileA = path.join(repoRoot, 'notes-a.md');
  const sourceFileB = path.join(repoRoot, 'notes-b.md');
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'repo-scoped-esm-app', type: 'module' }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(repoRoot, 'wf.config.js'),
    [
      'module.exports = {',
      '  ai: [',
      '    {',
      '      provider: "openai",',
      '      apiKey: "repo-openai-key",',
      '      model: "gpt-5.4",',
      '      default: true,',
      '    },',
      '    {',
      '      provider: "google",',
      '      apiKey: "repo-gemini-key",',
      '      model: "gemini-2.5-pro",',
      '    },',
      '  ],',
      '  stages: {',
      '    generate: {',
      '      provider: "openai",',
      '      model: "gpt-5.4",',
      '    },',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(sourceFileA, '# Notes A\n\nShort repo-scoped source content.\n', 'utf-8');
  fs.writeFileSync(sourceFileB, '# Notes B\n\nA second short source forces AI synthesis.\n', 'utf-8');

  const configCwd = resolveConfigCwd(['issue:generate', sourceFileA, sourceFileB, '--repos', repoRoot]);

  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  const { counts, pass, fail } = createReporter();
  const originalExecute = AiService.prototype.execute;
  let aiCallCount = 0;
  let executedStage: string | undefined;
  let executedProvider: string | undefined;
  let capturedStdout = '';
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  try {
    await initializeWfConfig(configCwd);
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
    });

    const configService = app.get(ConfigService);
    if (configCwd === repoRoot) {
      pass('resolveConfigCwd selected the local repo from --repos');
    } else {
      fail('resolveConfigCwd did not select the local repo', configCwd);
    }

    const activeProvider = configService.get<string>('ai.provider');
    const openaiApiKey = configService.get<string>('ai.openaiApiKey');
    const geminiApiKey = configService.get<string>('ai.geminiApiKey');
    const generateProvider = configService.get<string>('stages.generate.provider');
    const generateModel = configService.get<string>('stages.generate.model');

    if (activeProvider === 'openai' && openaiApiKey === 'repo-openai-key' && geminiApiKey === 'repo-gemini-key') {
      pass('repo-local providers were loaded instead of built-in defaults');
    } else {
      fail(
        'repo-local provider config was not preserved',
        JSON.stringify({
          activeProvider,
          openaiApiKey,
          geminiApiKey,
        })
      );
    }

    if (generateProvider === 'openai' && generateModel === 'gpt-5.4') {
      pass('stages.generate override came from the repo-local config');
    } else {
      fail(
        'stages.generate override was not loaded from the repo-local config',
        JSON.stringify({ generateProvider, generateModel })
      );
    }

    (AiService.prototype as any).execute = async (input: Parameters<AiService['execute']>[0]) => {
      aiCallCount += 1;
      executedStage = input.stage;
      executedProvider = activeProvider;
      return { content: MOCK_AI_RESPONSE };
    };

    (process.stdout.write as any) = (chunk: string | Uint8Array) => {
      capturedStdout += String(chunk);
      return true;
    };

    const command = app.get(IssueGenerateCommand);
    await command.run([sourceFileA, sourceFileB], {
      repos: [repoRoot],
      silent: true,
    });

    if (aiCallCount === 1 && executedStage === 'generate') {
      pass('issue:generate reached the AI synthesis path with stage=generate');
    } else {
      fail(
        'issue:generate did not reach the expected AI synthesis path',
        JSON.stringify({ aiCallCount, executedStage })
      );
    }

    if (
      executedProvider === 'openai'
      && capturedStdout.includes('Repo Scoped Title')
      && capturedStdout.includes('Repo-scoped config loaded successfully.')
    ) {
      pass('generated output used the mocked synthesized ticket content');
    } else {
      fail('generated output did not match the mocked synthesized ticket', capturedStdout.slice(0, 400));
    }
  } finally {
    AiService.prototype.execute = originalExecute;
    process.stdout.write = originalStdoutWrite;
    await app?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('All tests passed! ✓');
  }
  console.log('━'.repeat(60) + '\n');

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
