/**
 * Manual Test: issue:generate repo-scoped wf.config.js loading in ESM repos
 *
 * Run: nr test:manual issue-generate-repo-config-loader.smoke.ts
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

const { counts, pass, fail } = createReporter();

const configLines = [
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
];

function buildConfigContent(): string {
  return configLines.join('\n');
}

function writeConfigFile(repoRoot: string): void {
  const content = buildConfigContent();
  fs.writeFileSync(path.join(repoRoot, 'wf.config.js'), content, 'utf-8');
}

function setupRepoStructure(
  repoRoot: string,
  sourceFileA: string,
  sourceFileB: string
): void {
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'repo-scoped-esm-app', type: 'module' }, null, 2),
    'utf-8'
  );
  writeConfigFile(repoRoot);
  fs.writeFileSync(sourceFileA, '# Notes A\n\nShort repo-scoped source content.\n', 'utf-8');
  fs.writeFileSync(sourceFileB, '# Notes B\n\nA second short source forces AI synthesis.\n', 'utf-8');
}

function verifyConfigResolution(configCwd: string, repoRoot: string): void {
  if (configCwd === repoRoot) {
    pass('resolveConfigCwd selected the local repo from --repos');
  } else {
    fail('resolveConfigCwd did not select the local repo', configCwd);
  }
}

function checkOpenaiConfig(activeProvider: string, openaiApiKey: string, geminiApiKey: string): boolean {
  return activeProvider === 'openai' && openaiApiKey === 'repo-openai-key' && geminiApiKey === 'repo-gemini-key';
}

function verifyAiProviders(configService: any): void {
  const activeProvider = configService.get('ai.provider') as string;
  const openaiApiKey = configService.get('ai.openaiApiKey') as string;
  const geminiApiKey = configService.get('ai.geminiApiKey') as string;
  if (checkOpenaiConfig(activeProvider, openaiApiKey, geminiApiKey)) {
    pass('repo-local providers were loaded instead of built-in defaults');
  } else {
    fail(
      'repo-local provider config was not preserved',
      JSON.stringify({ activeProvider, openaiApiKey, geminiApiKey })
    );
  }
}

function verifyGenerateStage(configService: any): void {
  const generateProvider = configService.get('stages.generate.provider') as string;
  const generateModel = configService.get('stages.generate.model') as string;
  if (generateProvider === 'openai' && generateModel === 'gpt-5.4') {
    pass('stages.generate override came from the repo-local config');
  } else {
    fail(
      'stages.generate override was not loaded from the repo-local config',
      JSON.stringify({ generateProvider, generateModel })
    );
  }
}

function verifySynthesisPath(
  aiCallCount: number,
  executedStage: string | undefined
): void {
  if (aiCallCount === 1 && executedStage === 'generate') {
    pass('issue:generate reached the AI synthesis path with stage=generate');
  } else {
    fail(
      'issue:generate did not reach the expected AI synthesis path',
      JSON.stringify({ aiCallCount, executedStage })
    );
  }
}

function verifyOutput(
  executedProvider: string | undefined,
  capturedStdout: string
): void {
  if (
    executedProvider === 'openai'
    && capturedStdout.includes('Repo Scoped Title')
    && capturedStdout.includes('Repo-scoped config loaded successfully.')
  ) {
    pass('generated output used the mocked synthesized ticket content');
  } else {
    fail('generated output did not match the mocked synthesized ticket', capturedStdout.slice(0, 400));
  }
}

function buildMockConfig(): Record<string, any> {
  return {
    aiCallCount: 0,
    executedStage: undefined,
    executedProvider: undefined,
    capturedStdout: '',
  };
}

function setupAiServiceMock(
  configService: any,
  mockConfig: Record<string, any>
): void {
  (AiService.prototype as any).execute = async (input: Parameters<AiService['execute']>[0]) => {
    mockConfig.aiCallCount += 1;
    mockConfig.executedStage = input.stage;
    mockConfig.executedProvider = configService.get('ai.provider') as string;
    return { content: MOCK_AI_RESPONSE };
  };
}

function setupStdoutMock(mockConfig: Record<string, any>): void {
  (process.stdout.write as any) = (chunk: string | Uint8Array) => {
    mockConfig.capturedStdout += String(chunk);
    return true;
  };
}

function createTestEnvironment(): {
  tempRoot: string;
  repoRoot: string;
  sourceFileA: string;
  sourceFileB: string;
} {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-repo-config-loader-'));
  const repoRoot = path.join(tempRoot, 'repo-scoped-esm-app');
  fs.mkdirSync(repoRoot, { recursive: true });
  const sourceFileA = path.join(repoRoot, 'notes-a.md');
  const sourceFileB = path.join(repoRoot, 'notes-b.md');
  setupRepoStructure(repoRoot, sourceFileA, sourceFileB);
  return { tempRoot, repoRoot, sourceFileA, sourceFileB };
}

async function runCommandTest(
  command: IssueGenerateCommand,
  sourceFileA: string,
  sourceFileB: string,
  repoRoot: string
): Promise<void> {
  await command.run([sourceFileA, sourceFileB], {
    repos: [repoRoot],
    silent: true,
  });
}

function runConfigVerifications(
  configCwd: string,
  repoRoot: string,
  configService: any
): void {
  verifyConfigResolution(configCwd, repoRoot);
  verifyAiProviders(configService);
  verifyGenerateStage(configService);
}

function runTestVerifications(mockConfig: Record<string, any>): void {
  verifySynthesisPath(mockConfig.aiCallCount, mockConfig.executedStage);
  verifyOutput(mockConfig.executedProvider, mockConfig.capturedStdout);
}

function setupMocksAndRun(
  configService: any,
  mockConfig: Record<string, any>,
  sourceFileA: string,
  sourceFileB: string,
  repoRoot: string,
  command: IssueGenerateCommand
): Promise<void> {
  setupAiServiceMock(configService, mockConfig);
  setupStdoutMock(mockConfig);
  return runCommandTest(command, sourceFileA, sourceFileB, repoRoot);
}

async function cleanupAndRestore(
  originalExecute: any,
  originalStdoutWrite: any,
  app: any
): Promise<void> {
  AiService.prototype.execute = originalExecute;
  process.stdout.write = originalStdoutWrite;
  await app.close();
}

async function initializeApp(
  configCwd: string
): Promise<Awaited<ReturnType<typeof NestFactory.createApplicationContext>>> {
  await initializeWfConfig(configCwd);
  return NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
}

function verifyAllConfigs(app: any, configCwd: string, repoRoot: string): void {
  const cs = app.get(ConfigService);
  verifyConfigResolution(configCwd, repoRoot);
  verifyAiProviders(cs);
  verifyGenerateStage(cs);
}

async function executeAndVerifyTest(app: any, opts: any): Promise<void> {
  verifyAllConfigs(app, opts.configCwd, opts.repoRoot);
  setupAiServiceMock(app.get(ConfigService), opts.mockConfig);
  setupStdoutMock(opts.mockConfig);
  await runCommandTest(app.get(IssueGenerateCommand), opts.sourceFileA, opts.sourceFileB, opts.repoRoot);
  runTestVerifications(opts.mockConfig);
}

async function runTestWithApp(options: {
  configCwd: string;
  sourceFileA: string;
  sourceFileB: string;
  repoRoot: string;
  mockConfig: Record<string, any>;
  originalExecute: any;
  originalStdoutWrite: any;
}): Promise<void> {
  const app = await initializeApp(options.configCwd);
  await executeAndVerifyTest(app, options);
  await cleanupAndRestore(options.originalExecute, options.originalStdoutWrite, app);
}

function reportResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(
    `Results: ${counts.passed} passed   ${counts.failed} failed`
  );
  if (counts.failed === 0) {
    console.log('All tests passed! ✓');
  }
  console.log('━'.repeat(60) + '\n');
}

function buildRunTestWithAppOptions(env: any, cwd: string): Parameters<typeof runTestWithApp>[0] {
  return {
    configCwd: cwd,
    sourceFileA: env.sourceFileA,
    sourceFileB: env.sourceFileB,
    repoRoot: env.repoRoot,
    mockConfig: buildMockConfig(),
    originalExecute: AiService.prototype.execute,
    originalStdoutWrite: process.stdout.write.bind(process.stdout),
  };
}

async function runFullTest(env: any): Promise<void> {
  const cwd = resolveConfigCwd(['issue:generate', env.sourceFileA, env.sourceFileB, '--repos', env.repoRoot]);
  try {
    await runTestWithApp(buildRunTestWithAppOptions(env, cwd));
  } finally {
    fs.rmSync(env.tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: issue:generate repo-scoped wf.config.js loading\n');
  await runFullTest(createTestEnvironment());
  reportResults();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
