/**
 * Manual Test: issue:update Jira ADF payload smoke test
 *
 * Run:
 * nr test:manual issue-update-jira-adf.smoke.ts WBP-3092 \
 *   --description-file .wf/terraform-aws/jira/ticket-description.md
 *
 * With no arguments, previews a built-in sample description for WBP-0000
 * (never sends a live update).
 *
 * Preview mode builds the exact outgoing Jira update payload through the
 * JiraAdapter and JiraService update path without performing a live PUT.
 * Add --live --confirm-live-update to execute the Jira update after the
 * preview diagnostics are printed. A Y/n confirmation prompt is shown
 * before the live PUT so you can verify the target ticket key.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NestFactory } from '@nestjs/core';
import { of } from 'rxjs';
import { UniversalTicket } from '../../src/common/dto/universal-ticket.dto';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import { JiraAdapter } from '../../src/integrations/issue-trackers/jira/jira-adapter';
import {
  loadDescriptionFile,
  parseJiraUpdateSmokeArgs,
  captureJiraDescriptionUpdatePreview,
} from '../../src/common/utils/jira-update-smoke';

function buildConfigValues(): Record<string, string> {
  return {
    'atlassian.baseUrl': process.env.ATLASSIAN_BASE_URL || 'https://preview.atlassian.net',
    'atlassian.email': process.env.ATLASSIAN_EMAIL || 'preview@example.com',
    'atlassian.apiToken': process.env.ATLASSIAN_API_TOKEN || 'preview-token',
    'atlassian.jira.defaultProject': process.env.ATLASSIAN_JIRA_DEFAULT_PROJECT || 'WBP',
  };
}

function createConfigGetter(configValues: Record<string, string>): any {
  return { get: (key: string) => configValues[key] };
}

function createJiraService(configValues: Record<string, string>): JiraService {
  return new JiraService(
    createConfigGetter(configValues),
    { put: () => of({ data: {} }) } as any,
    { warn: () => undefined, success: () => undefined } as any,
    { isTrackerEnabled: () => true } as any
  );
}

function createPreviewDependencies(): { adapter: JiraAdapter; jiraService: JiraService } {
  const configValues = buildConfigValues();
  const jiraService = createJiraService(configValues);
  const adapter = new JiraAdapter(jiraService, { get: () => configValues['atlassian.baseUrl'] } as any);
  return { adapter, jiraService };
}

/**
 * Prompt the user with a Y/n question and return whether they confirmed.
 *
 * @param question - The prompt text shown to the user
 * @returns `true` when the user answers `Y` or `y`, `false` otherwise
 */
const askConfirmation = (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
};

function printValidationIssues(
  validationResult: {
    passed: boolean;
    issues: Array<{ error: string; suggestion: string }>;
  }
): void {
  for (const issue of validationResult.issues) {
    console.log(`  FAIL: ${issue.error}`);
    console.log(`        ${issue.suggestion}`);
  }
}

function printOutputSummary(result: any, args: any): void {
  console.log('\nManual Test: issue:update Jira ADF payload smoke test\n');
  console.log(`Mode: ${args.executeLiveUpdate ? 'live update' : 'preview'}`);
  console.log(`Ticket: ${result.ticketKey}`);
  console.log(`Description file: ${args.descriptionFilePath}`);
  console.log(
    `Formatting summary: headings=${result.formattingSummary.headingCount}, codeBlocks=${result.formattingSummary.codeBlockCount}, bulletLists=${result.formattingSummary.bulletListCount}, orderedLists=${result.formattingSummary.orderedListCount}`
  );
  console.log('Payload preview:');
  console.log(result.serializedPayload);
}

async function handleLiveUpdate(args: any, dependencies: any, description: string): Promise<void> {
  const confirmed = await askConfirmation(`\nUpdate ${args.ticketKey}? (y/N) `);
  if (!confirmed) {
    console.log('Cancelled. No live Jira update was sent.');
    return;
  }
  await dependencies.adapter.updateTicket(args.ticketKey, new UniversalTicket({ description }));
  console.log('PASS: Jira description update preview completed and live update was sent.');
}

async function getDependencies(
  app: any
): Promise<{ adapter: JiraAdapter; jiraService: JiraService }> {
  return app === null
    ? createPreviewDependencies()
    : { adapter: app.get(JiraAdapter), jiraService: app.get(JiraService) };
}

async function runPreview(args: any, dependencies: any): Promise<any> {
  const description = loadDescriptionFile(args.descriptionFilePath);
  const result = await captureJiraDescriptionUpdatePreview({
    ticketKey: args.ticketKey,
    description,
    adapter: dependencies.adapter,
    jiraService: dependencies.jiraService,
  });
  return { description, result };
}

function validateAdfPayload(result: any): any {
  assert.strictEqual((result.payload.fields.description as { type: string }).type, 'doc');
  const validation = spawnSync('npx', ['ts-node', 'test/manual/verify-request-format.smoke.ts'], {
    input: result.serializedPayload,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return JSON.parse(validation.stdout);
}

function assertPayloadValid(validationResult: any): void {
  assert(validationResult.passed, `ADF payload has ${validationResult.issues.length} formatting issue(s)`);
}

async function completePayloadHandling(args: any, dependencies: any, description: string): Promise<void> {
  if (args.executeLiveUpdate) await handleLiveUpdate(args, dependencies, description);
  else console.log('PASS: Preview completed without sending live update.');
}

async function handlePayloadResult(
  validationResult: any,
  result: any,
  args: any,
  dependencies: any,
  description: string
): Promise<void> {
  printValidationIssues(validationResult);
  assertPayloadValid(validationResult);
  printOutputSummary(result, args);
  await completePayloadHandling(args, dependencies, description);
}

async function validateAndProcess(result: any, args: any, dependencies: any, description: string): Promise<void> {
  const validationResult = validateAdfPayload(result);
  await handlePayloadResult(validationResult, result, args, dependencies, description);
}

const sampleDescription = [
  '## Summary',
  '',
  'Sample **bold** and `inline code` text.',
  '',
  '```ts',
  'const value = 1;',
  '```',
  '',
  '- First bullet',
  '- Second bullet',
  '',
  '1. First step',
  '2. Second step',
  '',
].join('\n');

function resolveSmokeArgv(): { argv: string[]; cleanup: () => void } {
  const argv = process.argv.slice(3);
  if (argv.length > 0) return { argv, cleanup: () => undefined };
  const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-jira-adf-sample-'));
  const samplePath = path.join(sampleDir, 'description.md');
  fs.writeFileSync(samplePath, sampleDescription, 'utf-8');
  return {
    argv: ['WBP-0000', '--description-file', samplePath],
    cleanup: () => fs.rmSync(sampleDir, { recursive: true, force: true }),
  };
}

async function main(): Promise<void> {
  const { argv, cleanup } = resolveSmokeArgv();
  const args = parseJiraUpdateSmokeArgs(argv);
  const app = args.executeLiveUpdate ? await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] }) : null;
  try {
    const dependencies = await getDependencies(app);
    const { description, result } = await runPreview(args, dependencies);
    await validateAndProcess(result, args, dependencies, description);
  } finally {
    await app?.close();
    cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
