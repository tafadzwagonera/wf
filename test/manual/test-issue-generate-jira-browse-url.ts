/**
 * Manual Test: issue:generate Jira browse URL routing smoke test
 *
 * Run: nr test:manual -- test-issue-generate-jira-browse-url
 *
 * Verifies:
 *   1. Jira browse URLs are routed through fetchFromTracker (not fetchFromUrl).
 *   2. AI synthesis always runs, even for single tracker sources with long descriptions.
 *   3. Non-browse Atlassian URLs fall through to the generic URL handler.
 *   4. Self-hosted Jira instances are supported when atlassian.baseUrl is configured.
 *
 * No real AI or platform calls are made.
 */

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';

const MOCK_AI_RESPONSE = JSON.stringify({
  title: 'Enriched Ticket Title',
  type: 'bug',
  priority: 'high',
  description: [
    '## Description',
    '',
    '### Summary',
    'AI-enriched summary of the tracker ticket.',
    '',
    '#### Technical Details',
    '- None',
    '',
    '### Acceptance Criteria',
    '- None',
    '',
    '### Risks & Assumptions',
    '- None',
    '',
    '#### Out of Scope',
    '- None',
  ].join('\n'),
});

const pass = (message: string): void => {
  console.log(`  \u2713 ${message}`);
};

const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`);
};

async function main() {
  console.log('\n\ud83e\uddea issue:generate Jira browse URL routing smoke test\n');

  let passed = 0;
  let failed = 0;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const command = app.get(IssueGenerateCommand);

  try {
    // ── Test 1: parseTrackerSource routes *.atlassian.net/browse/<KEY> ──

    console.log('Test 1: parseTrackerSource detects Jira browse URLs');
    const result1 = (command as any).parseTrackerSource('https://touraxis.atlassian.net/browse/WBP-3371');
    if (result1?.ticketKey === 'WBP-3371') {
      pass('Parsed browse URL to ticketKey WBP-3371');
      passed++;
    } else {
      fail('Expected ticketKey WBP-3371', `Got: ${JSON.stringify(result1)}`);
      failed++;
    }

    // ── Test 2: parseTrackerSource returns null for Confluence URLs ──

    console.log('Test 2: parseTrackerSource rejects non-browse Atlassian URLs');
    const confluenceResult = (command as any).parseTrackerSource(
      'https://touraxis.atlassian.net/wiki/spaces/DEV/pages/123'
    );
    const boardResult = (command as any).parseTrackerSource(
      'https://touraxis.atlassian.net/jira/software/projects/WBP/boards/1'
    );
    if (confluenceResult === null && boardResult === null) {
      pass('Confluence and board URLs return null');
      passed++;
    } else {
      fail(
        'Expected null for non-browse URLs',
        `Confluence: ${JSON.stringify(confluenceResult)}, Board: ${JSON.stringify(boardResult)}`
      );
      failed++;
    }

    // ── Test 3: parseTrackerSource rejects non-Atlassian URLs ──

    console.log('Test 3: parseTrackerSource rejects non-Atlassian URLs');
    const githubResult = (command as any).parseTrackerSource('https://github.com/org/repo/issues/42');
    if (githubResult === null) {
      pass('Non-Atlassian URL returns null');
      passed++;
    } else {
      fail('Expected null for GitHub URL', `Got: ${JSON.stringify(githubResult)}`);
      failed++;
    }

    // ── Test 4: parseTrackerSource supports self-hosted with config ──

    console.log('Test 4: parseTrackerSource supports self-hosted Jira with atlassian.baseUrl config');
    const configService = (command as any).configService as ConfigService;
    const originalGet = configService.get.bind(configService);
    const getSpy = (key: string, defaultValue?: string) => {
      if (key === 'atlassian.baseUrl') return 'https://jira.mycompany.com';
      return originalGet(key, defaultValue);
    };
    (configService as any).get = getSpy;

    try {
      const selfHostedResult = (command as any).parseTrackerSource('https://jira.mycompany.com/browse/PROJ-1');
      if (selfHostedResult?.ticketKey === 'PROJ-1') {
        pass('Self-hosted Jira with config returns ticketKey PROJ-1');
        passed++;
      } else {
        fail('Expected ticketKey PROJ-1', `Got: ${JSON.stringify(selfHostedResult)}`);
        failed++;
      }
    } finally {
      (configService as any).get = originalGet;
    }

    // ── Test 5: fetchSource routes browse URLs through fetchFromTracker ──

    console.log('Test 5: fetchSource routes Jira browse URLs to fetchFromTracker');
    const trackerCalls: string[] = [];
    const urlCalls: string[] = [];

    const originalFetchFromTracker = (command as any).fetchFromTracker.bind(command);
    const originalFetchFromUrl = (command as any).fetchFromUrl.bind(command);

    (command as any).fetchFromTracker = async (ticketKey: string, tracker?: string, repo?: string) => {
      trackerCalls.push(ticketKey);
      return {
        type: 'tracker',
        source: ticketKey,
        content: 'Mocked ticket content',
        ticket: { title: 'Mock', description: 'Mock desc', type: 'bug', priority: 'high' },
      };
    };
    (command as any).fetchFromUrl = async (url: string) => {
      urlCalls.push(url);
      return { type: 'url', source: url, content: 'HTML content' };
    };

    try {
      await (command as any).fetchSource('https://touraxis.atlassian.net/browse/WBP-3371', 'jira', 'my-repo');

      if (trackerCalls.includes('WBP-3371') && urlCalls.length === 0) {
        pass('Jira browse URL routed to fetchFromTracker, not fetchFromUrl');
        passed++;
      } else {
        fail(
          'Expected fetchFromTracker called with WBP-3371 and fetchFromUrl NOT called',
          `trackerCalls: ${JSON.stringify(trackerCalls)}, urlCalls: ${JSON.stringify(urlCalls)}`
        );
        failed++;
      }
    } finally {
      (command as any).fetchFromTracker = originalFetchFromTracker;
      (command as any).fetchFromUrl = originalFetchFromUrl;
    }

    // ── Test 6: synthesizeWithAI always runs AI (no bypass for long descriptions) ──

    console.log('Test 6: synthesizeWithAI always invokes AI even for single source with long description');
    const commandAiService = (command as any).aiService;
    const commandStageAgentService = (command as any).stageAgentService;
    const originalAiExecute = commandAiService.execute.bind(commandAiService);
    const originalGenerateFromPrompt = commandStageAgentService.generateFromPrompt.bind(commandStageAgentService);
    const originalIsEnabled = commandStageAgentService.isEnabledForStage.bind(commandStageAgentService);
    let aiCalled = false;
    commandAiService.execute = async () => {
      aiCalled = true;
      return { content: MOCK_AI_RESPONSE };
    };
    commandStageAgentService.generateFromPrompt = async () => {
      aiCalled = true;
      return { content: MOCK_AI_RESPONSE };
    };

    try {
      await (command as any).synthesizeWithAI(
        [
          {
            type: 'tracker',
            source: 'WBP-3371',
            content: 'Title\n\n' + 'Long description content. '.repeat(20),
            ticket: {
              title: 'Existing ticket',
              description: 'Long description content. '.repeat(20),
              type: 'bug',
              priority: 'high',
            },
          },
        ],
        true,
        undefined,
        undefined
      );

      if (aiCalled) {
        pass('AI synthesis invoked for single source with long description');
        passed++;
      } else {
        fail('AI synthesis was bypassed for single source with long description');
        failed++;
      }
    } finally {
      commandAiService.execute = originalAiExecute;
      commandStageAgentService.generateFromPrompt = originalGenerateFromPrompt;
      commandStageAgentService.isEnabledForStage = originalIsEnabled;
    }
  } finally {
    await app.close();
  }

  console.log('\nSummary');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
