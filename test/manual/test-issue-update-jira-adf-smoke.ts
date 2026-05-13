/**
 * Manual Test: issue:update Jira ADF payload smoke test
 *
 * Run:
 * nr test:manual -- test-issue-update-jira-adf-smoke WBP-3092 --description-file .wf/terraform-aws/jira/ticket-description.md
 *
 * Preview mode builds the exact outgoing Jira update payload through the
 * JiraAdapter and JiraService update path without performing a live PUT.
 * Add --live --confirm-live-update to execute the Jira update after the
 * preview diagnostics are printed.
 */

import assert from 'assert';
import { NestFactory } from '@nestjs/core';
import { of } from 'rxjs';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import { JiraAdapter } from '../../src/integrations/platforms/jira/jira-adapter';
import {
  parseJiraUpdateSmokeArgs,
  runJiraUpdateSmokeTest,
} from '../../src/test/manual/jira-update-smoke';

const createPreviewDependencies = (): {
  adapter: JiraAdapter;
  jiraService: JiraService;
} => {
  const configValues = {
    'atlassian.baseUrl':
      process.env.ATLASSIAN_BASE_URL || 'https://preview.atlassian.net',
    'atlassian.email': process.env.ATLASSIAN_EMAIL || 'preview@example.com',
    'atlassian.apiToken': process.env.ATLASSIAN_API_TOKEN || 'preview-token',
    'atlassian.jira.defaultProject':
      process.env.ATLASSIAN_JIRA_DEFAULT_PROJECT || 'WBP',
  };
  const jiraService = new JiraService(
    {
      get: (key: string) => configValues[key as keyof typeof configValues],
    } as any,
    {
      put: () => of({ data: {} }),
    } as any,
    {
      warn: () => undefined,
      success: () => undefined,
    } as any,
    {
      isPlatformEnabled: () => true,
    } as any,
  );
  const adapter = new JiraAdapter(jiraService, {
    get: () => configValues['atlassian.baseUrl'],
  } as any);

  return { adapter, jiraService };
};

const main = async (): Promise<void> => {
  const args = parseJiraUpdateSmokeArgs(process.argv.slice(3));
  const app = args.executeLiveUpdate
    ? await NestFactory.createApplicationContext(AppModule, {
        logger: ['error', 'warn'],
      })
    : null;

  try {
    const dependencies =
      app !== null
        ? {
            adapter: app.get(JiraAdapter),
            jiraService: app.get(JiraService),
          }
        : createPreviewDependencies();
    const result = await runJiraUpdateSmokeTest({
      ...args,
      adapter: dependencies.adapter,
      jiraService: dependencies.jiraService,
    });

    assert.strictEqual(
      (result.payload.fields.description as { type: string }).type,
      'doc',
    );
    assert(!result.serializedPayload.includes('{code}'));
    assert(!result.serializedPayload.includes('{noformat}'));

    console.log('\nManual Test: issue:update Jira ADF payload smoke test\n');
    console.log(`Mode: ${args.executeLiveUpdate ? 'live update' : 'preview'}`);
    console.log(`Ticket: ${result.ticketKey}`);
    console.log(`Description file: ${result.descriptionFilePath}`);
    console.log(
      `Formatting summary: headings=${result.formattingSummary.headingCount}, codeBlocks=${result.formattingSummary.codeBlockCount}, bulletLists=${result.formattingSummary.bulletListCount}, orderedLists=${result.formattingSummary.orderedListCount}`,
    );
    console.log('Payload preview:');
    console.log(result.serializedPayload);
    console.log(
      args.executeLiveUpdate
        ? 'PASS: Jira description update preview completed and live update was sent.'
        : 'PASS: Jira description update preview completed without sending a live Jira update.',
    );
  } finally {
    await app?.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
