/**
 * Manual Test: issue:update Jira ADF payload smoke test
 *
 * Run:
 * nr test:manual -- test-issue-update-jira-adf-smoke WBP-3092 --description-file .wf/terraform-aws/jira/ticket-description.md
 *
 * Preview mode builds the exact outgoing Jira update payload through the
 * JiraAdapter and JiraService update path without performing a live PUT.
 * Add --live --confirm-live-update to execute the Jira update after the
 * preview diagnostics are printed. A Y/n confirmation prompt is shown
 * before the live PUT so you can verify the target ticket key.
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { createInterface } from 'node:readline';
import { NestFactory } from '@nestjs/core';
import { of } from 'rxjs';
import { UniversalTicket } from '../../src/common/dto/universal-ticket.dto';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import { JiraAdapter } from '../../src/integrations/platforms/jira/jira-adapter';
import {
  loadDescriptionFile,
  parseJiraUpdateSmokeArgs,
  captureJiraDescriptionUpdatePreview,
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

/**
 * Prompt the user with a Y/n question and return whether they confirmed.
 *
 * @param question - The prompt text shown to the user
 * @returns `true` when the user answers `Y` or `y`, `false` otherwise
 */
const askConfirmation = (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
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

    const description = loadDescriptionFile(args.descriptionFilePath);
    const result = await captureJiraDescriptionUpdatePreview({
      ticketKey: args.ticketKey,
      description,
      adapter: dependencies.adapter,
      jiraService: dependencies.jiraService,
    });

    assert.strictEqual(
      (result.payload.fields.description as { type: string }).type,
      'doc',
    );

    const validation = spawnSync(
      'npx',
      ['ts-node', 'test/manual/test-verify-request-format.ts'],
      {
        input: result.serializedPayload,
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );

    const validationResult: {
      passed: boolean;
      issues: Array<{ error: string; suggestion: string }>;
    } = JSON.parse(validation.stdout);

    for (const issue of validationResult.issues) {
      console.log(`  FAIL: ${issue.error}`);
      console.log(`        ${issue.suggestion}`);
    }

    assert(
      validationResult.passed,
      `ADF payload has ${validationResult.issues.length} formatting issue(s)`,
    );

    console.log('\nManual Test: issue:update Jira ADF payload smoke test\n');
    console.log(`Mode: ${args.executeLiveUpdate ? 'live update' : 'preview'}`);
    console.log(`Ticket: ${result.ticketKey}`);
    console.log(`Description file: ${args.descriptionFilePath}`);
    console.log(
      `Formatting summary: headings=${result.formattingSummary.headingCount}, codeBlocks=${result.formattingSummary.codeBlockCount}, bulletLists=${result.formattingSummary.bulletListCount}, orderedLists=${result.formattingSummary.orderedListCount}`,
    );
    console.log('Payload preview:');
    console.log(result.serializedPayload);

    if (args.executeLiveUpdate) {
      const confirmed = await askConfirmation(
        `\nUpdate ${args.ticketKey}? (y/N) `,
      );

      if (!confirmed) {
        console.log('Cancelled. No live Jira update was sent.');
        return;
      }

      await dependencies.adapter.updateTicket(
        args.ticketKey,
        new UniversalTicket({ description }),
      );
      console.log(
        'PASS: Jira description update preview completed and live update was sent.',
      );
    } else {
      console.log(
        'PASS: Jira description update preview completed without sending a live Jira update.',
      );
    }
  } finally {
    await app?.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
