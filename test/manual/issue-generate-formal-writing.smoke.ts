/**
 * Manual Test: issue:generate formal writing conventions smoke test
 *
 * Run: nr test:manual issue-generate-formal-writing.smoke.ts
 *
 * Verifies:
 *   1. AI-synthesized `issue:generate` output expands contractions.
 *   2. Single-source imported ticket output expands contractions.
 *   3. Saved generated artifacts expand contractions.
 *
 * No real AI or platform calls are made.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { FormatConverterService } from '../../src/common/converters/format-converter.service';
import { createReporter } from './support/reporter';

const MOCK_AI_RESPONSE = `# Generated Title That Don't Work

**Type:** task
**Priority:** medium

## Description

### Summary
It's a summary that can't be used as-is

#### Technical Details
- None

### Acceptance Criteria
- None

### Risks & Assumptions
- None

#### Out of Scope
- None
`;

const { counts, pass, fail } = createReporter();

const CONTRACTION_PATTERN
  = /don't|can't|won't|isn't|aren't|doesn't|wasn't|weren't|couldn't|wouldn't|shouldn't|it's|that's|there's|here's|what's|who's|let's|i'm|we're|they're|you're|we've|they've|you've|i've|we'll|they'll|you'll|i'll|he's|she's/i;

/**
 * Verify a serialized output string contains no contractions.
 *
 * @param label Human-readable assertion label
 * @param content Serialized output content
 * @returns Nothing
 */
const assertNoContractions = (label: string, content: string): void => {
  const match = CONTRACTION_PATTERN.exec(content);
  if (match) {
    fail(label, `Found contraction "${match[0]}" in serialized output`);
    return;
  }

  pass(label);
};

async function runTest1(
  command: IssueGenerateCommand,
  synthesisSourceA: string,
  synthesisSourceB: string,
  synthesisOutputPath: string
): Promise<void> {
  console.log('Test 1: synthesized output written via --output expands contractions');
  await command.run([synthesisSourceA, synthesisSourceB], {
    format: 'md',
    output: synthesisOutputPath,
  } as any);
  const synthesizedOutput = fs.readFileSync(synthesisOutputPath, 'utf-8');
  assertNoContractions('Synthesized output expanded contractions to formal equivalents', synthesizedOutput);
}

function createMdMockConverter(): any {
  return {
    parse: () => ({
      title: 'Imported ticket that don\'t comply',
      description: 'Imported description that can\'t be used and it\'s long enough to bypass synthesis. '.repeat(3),
      type: 'task',
      priority: 'medium',
    }),
    serialize: (ticket: { title: string; description: string }) =>
      [`# ${ticket.title}`, '', ticket.description].join('\n'),
  };
}

function createMdConverterMock(originalMdConverter: any): any {
  return ((format: string) => format === 'md' ? createMdMockConverter() : originalMdConverter) as any;
}

function setupImportedTicketSpies(
  formatConverterService: FormatConverterService,
  originalMdConverter: any
): { detectSpy: any; converterSpy: any } {
  const detectSpy = jestlessSpy(formatConverterService, 'detectFormat', () => 'md');
  const converterSpy = jestlessSpy(formatConverterService, 'getConverter', createMdConverterMock(originalMdConverter));
  return { detectSpy, converterSpy };
}

function restoreImportedTicketSpies(spies: any): void {
  spies.detectSpy.restore();
  spies.converterSpy.restore();
}

function createImportedOutputPath(): string {
  return path.join(os.tmpdir(), `wf-imported-formal-output-${Date.now()}.md`);
}

function cleanupImportedOutput(outPath: string): void {
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
}

async function runImportedTest(cmd: IssueGenerateCommand, ticketPath: string, outPath: string): Promise<void> {
  await cmd.run([ticketPath], { format: 'md', output: outPath } as any);
  assertNoContractions('Imported ticket output expanded contractions to formal equivalents', fs.readFileSync(outPath, 'utf-8'));
}

async function runTest2(c: IssueGenerateCommand, f: FormatConverterService, p: string, m: any): Promise<void> {
  console.log('Test 2: single-source imported ticket output expands contractions');
  const out = createImportedOutputPath();
  const spy = setupImportedTicketSpies(f, m);
  try {
    await runImportedTest(c, p, out);
  } finally {
    restoreImportedTicketSpies(spy);
    cleanupImportedOutput(out);
  }
}

function cleanupArtifacts(artifactPath: string): void {
  const manifestPath = `${artifactPath}.sources.json`;
  if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
}

function createTicketForSave(): any {
  return { title: 'Saved artifact that don\'t comply', description: 'It\'s a saved artifact that can\'t stay informal', type: 'task', priority: 'medium' };
}

async function runTest3(command: IssueGenerateCommand): Promise<void> {
  console.log('Test 3: saved generated artifacts expand contractions');
  const artifactPath = await (command as any).saveTicketLocally(createTicketForSave(), 'jira', 'md', ['https://example.com/spec']);
  assertNoContractions('Saved artifact expanded contractions to formal equivalents', fs.readFileSync(artifactPath, 'utf-8'));
  cleanupArtifacts(artifactPath);
}

function createTestPaths(): { sourceA: string; sourceB: string; outputPath: string; importedPath: string } {
  return {
    sourceA: path.join(os.tmpdir(), `wf-gen-formal-a-${Date.now()}.txt`),
    sourceB: path.join(os.tmpdir(), `wf-gen-formal-b-${Date.now()}.txt`),
    outputPath: path.join(os.tmpdir(), `wf-gen-formal-output-${Date.now()}.md`),
    importedPath: path.join(os.tmpdir(), `wf-imported-formal-${Date.now()}.md`),
  };
}

function setupTestFiles(sourceA: string, sourceB: string, importedPath: string): void {
  fs.writeFileSync(sourceA, 'Source A: placeholder content.', 'utf-8');
  fs.writeFileSync(sourceB, 'Source B: placeholder content.', 'utf-8');
  fs.writeFileSync(importedPath, '# Imported ticket placeholder', 'utf-8');
}

function cleanupTestFiles(sourceA: string, sourceB: string, outputPath: string, importedPath: string): void {
  if (fs.existsSync(sourceA)) fs.unlinkSync(sourceA);
  if (fs.existsSync(sourceB)) fs.unlinkSync(sourceB);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  if (fs.existsSync(importedPath)) fs.unlinkSync(importedPath);
}

function reportFinalResults(): void {
  console.log('\nSummary');
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);
}

function setupAiMock(originalAiExecute: any): void {
  (AiService.prototype as any).execute = async () => ({ content: MOCK_AI_RESPONSE });
}

async function runAllTests(
  command: IssueGenerateCommand,
  fmtService: FormatConverterService,
  originalMdConverter: any,
  paths: any
): Promise<void> {
  const { sourceA, sourceB, outputPath, importedPath } = paths;
  await runTest1(command, sourceA, sourceB, outputPath);
  await runTest2(command, fmtService, importedPath, originalMdConverter);
  await runTest3(command);
}

async function createAppServices(): Promise<any> {
  return NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
}

function setupTestEnv(app: any): [any, any, any] {
  const cmd = app.get(IssueGenerateCommand);
  const fmt = app.get(FormatConverterService);
  return [cmd, fmt, fmt.getConverter('md')];
}

async function runTestSuite(cmd: any, fmt: any, mdConv: any, app: any, aiExec: any): Promise<void> {
  const p = createTestPaths();
  setupTestFiles(p.sourceA, p.sourceB, p.importedPath);
  try {
    await runAllTests(cmd, fmt, mdConv, p);
  } finally {
    AiService.prototype.execute = aiExec;
    cleanupTestFiles(p.sourceA, p.sourceB, p.outputPath, p.importedPath);
    await app.close();
  }
}

async function main(): Promise<void> {
  console.log(chalkHeader('\n\ud83e\uddea issue:generate formal writing conventions smoke test\n'));
  const app = await createAppServices();
  const [cmd, fmt, mdConv] = setupTestEnv(app);
  const aiExec = AiService.prototype.execute;
  setupAiMock(aiExec);
  await runTestSuite(cmd, fmt, mdConv, app, aiExec);
  reportFinalResults();
  if (counts.failed > 0) process.exit(1);
}

/**
 * Keep manual test output formatting simple and dependency-free.
 *
 * @param message Header text to print
 * @returns Unchanged header text
 */
const chalkHeader = (message: string): string => message;

/**
 * Temporarily replace an object property and expose a restore function.
 *
 * @param target Target object
 * @param key Property name to replace
 * @param replacement Temporary replacement value
 * @returns Handle that restores the original property
 */
const jestlessSpy = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K]
): { restore: () => void } => {
  const original = target[key];
  target[key] = replacement;

  return {
    restore: () => {
      target[key] = original;
    },
  };
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
