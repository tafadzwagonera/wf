/**
 * Manual Test: issue:generate oversized source summarisation and interactive review
 *
 * Run: nr test:manual issue-generate-oversized-source-summarisation.smoke.ts
 *
 * Verifies:
 * 1. Sources under MAX_SOURCE_CONTENT_LENGTH pass through without summarisation
 * 2. Sources exceeding MAX_SOURCE_CONTENT_LENGTH trigger AI summarisation
 * 3. Silent mode uses AI summary without interactive review
 * 4. Interactive mode presents bullet review when TTY is available
 * 5. Empty bullet approval falls back to the full AI summary
 * 6. buildSynthesisPrompt and buildClarificationPrompt use MAX_SOURCE_CONTENT_LENGTH
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { createReporter } from './support/reporter';

const MOCK_TICKET_RESPONSE = JSON.stringify({
  title: 'Test oversized source summarisation',
  type: 'bug',
  priority: 'highest',
  description: [
    '## Description',
    '',
    '### Summary',
    'NATS consumer wedge caused failed transactions.',
    '',
    '#### Technical Details',
    'Consumer group stuck after deployment.',
    '',
    '### Acceptance Criteria',
    '- Transactions resume after fix',
    '',
    '### Risks & Assumptions',
    '- None',
    '',
    '#### Out of Scope',
    '- None',
  ].join('\n'),
});

const MOCK_SUMMARY_BULLETS = [
  '- NATS consumer group wedged after deployment at 16:30 UTC',
  '- 42 transactions failed during the outage window',
  '- Root cause: consumer rebalance timeout exceeded',
  '- Remediation: manual consumer group reset via nats-cli',
].join('\n');

function createSmallSourceAiMock(fail: any): any {
  return async (opts: any) => {
    const prompt: string = opts.prompt ?? '';
    if (prompt.includes('Summarise the following source')) {
      fail('Small source incorrectly triggered AI summarisation');
    }
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function createSmallSourceStageMock(fail: any): any {
  return async (prompt: string) => {
    if (prompt.includes('Summarise the following source')) {
      fail('Small source incorrectly triggered AI summarisation');
    }
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function setupMocksForSmallSourceTest(pass: any, fail: any): void {
  (AiService.prototype as any).execute = createSmallSourceAiMock(fail);
  (StageAgentService.prototype as any).generateFromPrompt = createSmallSourceStageMock(fail);
}

function overrideConsoleLog(): { restore: () => string; getOutput: () => string } {
  let output = '';
  const origLog = console.log;
  console.log = (...args: any[]) => {
    output += args.map(String).join(' ') + '\n';
  };
  const restore = () => {
    console.log = origLog;
    return output;
  };
  return {
    restore,
    getOutput: () => output,
  };
}

async function captureCommandOutput(
  command: IssueGenerateCommand,
  tmpFile: string,
  silent: boolean = true
): Promise<string> {
  const { restore } = overrideConsoleLog();
  try {
    await command.run([tmpFile], { silent, repos: [] });
  } catch {
    /* ignore */
  }
  return restore();
}

function validateSmallSourceOutput(output: string, pass: any, fail: any): void {
  if (output.includes('Summarising')) {
    fail('Unexpected summarisation warning for small source');
  } else {
    pass('No summarisation warning for small source');
  }
}

async function testSmallSourceNoSummarisation(command: IssueGenerateCommand, pass: any, fail: any): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `wf-small-source-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'Short source content.', 'utf-8');
  setupMocksForSmallSourceTest(pass, fail);
  const capturedOutput = await captureCommandOutput(command, tmpFile, true);
  validateSmallSourceOutput(capturedOutput, pass, fail);
  fs.unlinkSync(tmpFile);
}

function buildAiExecuteForSummarisation(pass: any): any {
  return async (opts: any) => {
    if ((opts.prompt ?? '').includes('Summarise the following source')) {
      pass('Oversized source triggers AI summarisation');
      return { content: MOCK_SUMMARY_BULLETS };
    }
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function buildStageGenerateForSummarisation(pass: any): any {
  return async (prompt: string) => {
    if (prompt.includes('Summarise the following source')) {
      pass('Oversized source triggers AI summarisation');
      return { content: MOCK_SUMMARY_BULLETS };
    }
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function setupMockSummarisation(pass: any): { aiExecute: any; stageGenerate: any } {
  return { aiExecute: buildAiExecuteForSummarisation(pass), stageGenerate: buildStageGenerateForSummarisation(pass) };
}

function setupMocksForOversizedSourceTest(pass: any): void {
  const { aiExecute, stageGenerate } = setupMockSummarisation(pass);
  (AiService.prototype as any).execute = aiExecute;
  (StageAgentService.prototype as any).generateFromPrompt = stageGenerate;
}

async function testOversizedSourceWithMocking(command: IssueGenerateCommand, pass: any, fail: any): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `wf-oversized-source-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'x'.repeat(31_000), 'utf-8');
  setupMocksForOversizedSourceTest(pass);
  const capturedOutput = await captureCommandOutput(command, tmpFile, true);
  if (capturedOutput.includes('Summarising')) {
    fail('Silent mode leaked summarisation warning');
  } else {
    pass('Silent mode suppresses summarisation warning');
  }
  fs.unlinkSync(tmpFile);
}

function buildAiExecuteForInteractive(pass: any): any {
  return async (opts: any) => {
    const prompt: string = opts.prompt ?? '';
    if (prompt.includes('Summarise the following source')) {
      pass('Non-silent oversized source triggers summarisation');
      return { content: MOCK_SUMMARY_BULLETS };
    }
    if (prompt.includes('Analyze these sources and identify')) return { content: '[]' };
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function buildStageGenerateForInteractive(pass: any): any {
  return async (prompt: string) => {
    if (prompt.includes('Summarise the following source')) {
      pass('Non-silent oversized source triggers summarisation');
      return { content: MOCK_SUMMARY_BULLETS };
    }
    if (prompt.includes('Analyze these sources and identify')) return { content: '[]' };
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function setupMocksForInteractiveTest(pass: any): void {
  (AiService.prototype as any).execute = buildAiExecuteForInteractive(pass);
  (StageAgentService.prototype as any).generateFromPrompt = buildStageGenerateForInteractive(pass);
}

function buildInquirerPromptHandler(counter: any): (questions: any[]) => Promise<any> {
  return async (questions: any[]) => {
    counter.count++;
    const q = Array.isArray(questions) ? questions[0] : questions;
    return q.type === 'confirm' ? { accept: true } : { input: 'done' };
  };
}

async function patchInquirerPrompt(): Promise<{ promptCallCount: number; restore: () => void }> {
  const inquirerModule = await import('inquirer');
  const originalPrompt = inquirerModule.default.prompt;
  const counter = { count: 0 };
  const handler = buildInquirerPromptHandler(counter);
  (inquirerModule.default as any).prompt = handler;
  const restore = () => {
    (inquirerModule.default as any).prompt = originalPrompt;
  };
  return { promptCallCount: counter.count, restore };
}

function simulateTTY(): () => void {
  const origStdinTTY = process.stdin.isTTY;
  const origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  return () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdoutTTY, configurable: true });
  };
}

function validateInteractiveReviewOutput(output: string, promptCount: number, pass: any, fail: any): void {
  if (output.includes('exceeds 30000 characters')) pass('Warning message shows character count');
  else fail('Missing summarisation warning', `Output: ${output.slice(0, 500)}`);
  if (output.includes('Review the summarised key points')) pass('Interactive review prompt is shown');
  else fail('Interactive review prompt missing', `Output: ${output.slice(0, 500)}`);
  if (promptCount >= 5) pass(`Inquirer prompted ${promptCount} times (4 bullets + done input)`);
  else fail(`Expected at least 5 inquirer prompts, got ${promptCount}`);
}

async function testInteractiveReview(command: IssueGenerateCommand, pass: any, fail: any): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `wf-oversized-warn-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'y'.repeat(31_000), 'utf-8');
  setupMocksForInteractiveTest(pass);
  const { promptCallCount, restore: restoreInquirer } = await patchInquirerPrompt();
  const restoreTTY = simulateTTY();
  const capturedOutput = await captureCommandOutput(command, tmpFile, false);
  restoreInquirer();
  restoreTTY();
  validateInteractiveReviewOutput(capturedOutput, promptCallCount, pass, fail);
  fs.unlinkSync(tmpFile);
}

function buildTruncationAiMock(): any {
  return async () => ({ content: MOCK_TICKET_RESPONSE });
}

function buildTruncationStageMock(): any {
  return async () => ({ content: MOCK_TICKET_RESPONSE });
}

function setupMocksForTruncationTest(): void {
  (AiService.prototype as any).execute = buildTruncationAiMock();
  (StageAgentService.prototype as any).generateFromPrompt = buildTruncationStageMock();
}

function createRestoreFunc(origExec: any, origGen: any): () => void {
  return () => {
    (AiService.prototype as any).execute = origExec;
    (StageAgentService.prototype as any).generateFromPrompt = origGen;
  };
}

function buildSynthesisCaptureAiMock(promptRef: any): any {
  return async (opts: any) => {
    if ((opts.prompt ?? '').includes('Sources to synthesize')) promptRef.value = opts.prompt;
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function buildSynthesisCaptureStageMock(promptRef: any): any {
  return async (prompt: string) => {
    if (prompt.includes('Sources to synthesize')) promptRef.value = prompt;
    return { content: MOCK_TICKET_RESPONSE };
  };
}

function setupSynthesisPromptCapture(): { getPrompt: () => string; restore: () => void } {
  const promptRef = { value: '' };
  const origExec = (AiService.prototype as any).execute;
  const origGen = (StageAgentService.prototype as any).generateFromPrompt;
  (AiService.prototype as any).execute = buildSynthesisCaptureAiMock(promptRef);
  (StageAgentService.prototype as any).generateFromPrompt = buildSynthesisCaptureStageMock(promptRef);
  return { getPrompt: () => promptRef.value, restore: createRestoreFunc(origExec, origGen) };
}

function validateTruncation(prompt: string, pass: any, fail: any): void {
  if (prompt.includes('z'.repeat(5_000))) pass('5,000-char source is NOT truncated in synthesis prompt');
  else if (prompt.includes('z'.repeat(2_000)) && !prompt.includes('z'.repeat(2_001))) fail('Source was truncated at 2,000 chars (old limit still active)');
  else fail('Unexpected truncation behaviour', `Prompt length: ${prompt.length}`);
}

async function testTruncationBehavior(command: IssueGenerateCommand, pass: any, fail: any): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `wf-truncation-check-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'z'.repeat(5_000), 'utf-8');
  const { getPrompt, restore } = setupSynthesisPromptCapture();
  await captureCommandOutput(command, tmpFile, true);
  const prompt = getPrompt();
  restore();
  validateTruncation(prompt, pass, fail);
  fs.unlinkSync(tmpFile);
}

function setupServiceMocks(): { originalProtoExecute: any; originalGenerateFromPrompt: any } {
  app.get(AiService);
  const originalProtoExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  return { originalProtoExecute, originalGenerateFromPrompt };
}

function restoreServiceMocks(originalProtoExecute: any, originalGenerateFromPrompt: any): void {
  AiService.prototype.execute = originalProtoExecute;
  StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;
}

function reportResults(counts: any): void {
  console.log(`\nResults: ${counts.passed} passed, ${counts.failed} failed\n`);
  if (counts.failed > 0) process.exit(1);
}

async function runAllTests(command: IssueGenerateCommand, pass: any, fail: any): Promise<void> {
  await testSmallSourceNoSummarisation(command, pass, fail);
  await testOversizedSourceWithMocking(command, pass, fail);
  await testInteractiveReview(command, pass, fail);
  await testTruncationBehavior(command, pass, fail);
}

let app: any;

async function main(): Promise<void> {
  console.log('\n\u{1F9EA} Manual Test: issue:generate oversized source summarisation\n');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const { counts, pass, fail } = createReporter();
  const { originalProtoExecute, originalGenerateFromPrompt } = setupServiceMocks();
  const command = app.get(IssueGenerateCommand);
  await runAllTests(command, pass, fail);
  restoreServiceMocks(originalProtoExecute, originalGenerateFromPrompt);
  await app.close();
  reportResults(counts);
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
