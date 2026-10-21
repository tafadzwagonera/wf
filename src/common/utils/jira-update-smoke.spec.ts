import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { of } from 'rxjs';
import { JiraService } from '../../integrations/jira/jira.service';
import { JiraAdapter } from '../../integrations/issue-trackers/jira/jira-adapter';
import { UniversalTicket } from '../dto/universal-ticket.dto';
import {
  captureJiraDescriptionUpdatePreview,
  loadDescriptionFile,
  normalizeDescriptionMarkdown,
  parseJiraUpdateSmokeArgs,
  runJiraUpdateSmokeTest,
} from './jira-update-smoke';

describe('jira-update-smoke', () => {
  const createHarness = (): {
    adapter: JiraAdapter;
    jiraService: JiraService;
    putCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]>;
  } => {
    const putCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [];
    const jiraService = new JiraService(
      {
        get: (key: string) =>
          ({
            'atlassian.baseUrl': 'https://test.atlassian.net',
            'atlassian.email': 'test@example.com',
            'atlassian.apiToken': 'test-token',
            'atlassian.jira.defaultProject': 'WBP',
          })[key],
      } as any,
      {
        put: (url: string, payload: Record<string, unknown>, config: Record<string, unknown>) => {
          putCalls.push([url, payload, config]);
          return of({ data: {} });
        },
      } as any,
      {
        success: jest.fn(),
        warn: jest.fn(),
      } as any,
      {
        isTrackerEnabled: () => true,
      } as any
    );
    const adapter = new JiraAdapter(jiraService, {
      get: jest.fn(),
    } as any);

    return { adapter, jiraService, putCalls };
  };

  it('parses preview mode args and resolves the description file path', () => {
    const args = parseJiraUpdateSmokeArgs(
      ['WBP-3092', '--description-file', '.wf/terraform-aws/jira/example-description.md'],
      '/tmp/wf',
      {}
    );

    expect(args).toEqual({
      ticketKey: 'WBP-3092',
      descriptionFilePath: '/tmp/wf/.wf/terraform-aws/jira/example-description.md',
      executeLiveUpdate: false,
      confirmLiveUpdate: false,
    });
  });

  it('captures a preview payload with Jira-safe ADF formatting counts', async () => {
    const { adapter, jiraService } = createHarness();

    const result = await captureJiraDescriptionUpdatePreview({
      ticketKey: 'WBP-3092',
      description: [
        '### Summary',
        'Persist the generated Jira description artifact.',
        '',
        '```json',
        '{',
        '  "ticket": "WBP-3092"',
        '}',
        '```',
        '',
        '- First bullet',
        '- Second bullet',
        '',
        '1. First ordered item',
      ].join('\n'),
      adapter,
      jiraService,
    });

    expect(result.ticketKey).toBe('WBP-3092');
    expect(result.payload).toEqual({
      fields: expect.objectContaining({
        description: expect.objectContaining({
          type: 'doc',
        }),
      }),
    });
    expect(result.formattingSummary).toEqual({
      headingCount: 1,
      codeBlockCount: 1,
      bulletListCount: 1,
      orderedListCount: 1,
    });
    expect(result.serializedPayload).not.toContain('{code}');
    expect(result.serializedPayload).not.toContain('{noformat}');
    expect(result.serializedPayload).not.toContain('* First bullet');
  });

  it('fails early when live mode is requested without explicit confirmation', () => {
    expect(() =>
      parseJiraUpdateSmokeArgs(['WBP-3092', '--description-file', 'ticket.md', '--live'], '/tmp/wf', {})
    ).toThrow('Live Jira updates require explicit confirmation via --confirm-live-update.');
  });

  it('accepts live mode from the environment when confirmation is present', () => {
    const args = parseJiraUpdateSmokeArgs(
      ['WBP-3092', '--description-file', 'ticket.md', '--confirm-live-update'],
      '/tmp/wf',
      { JIRA_UPDATE_LIVE: 'true' }
    );

    expect(args.executeLiveUpdate).toBe(true);
    expect(args.confirmLiveUpdate).toBe(true);
  });

  it('updates only the ticket description during preview capture', async () => {
    const { adapter, jiraService } = createHarness();

    const result = await captureJiraDescriptionUpdatePreview({
      ticketKey: 'WBP-3092',
      description: '### Summary\nDescription only update',
      adapter,
      jiraService,
    });

    expect(result.payload).toEqual({
      fields: {
        description: expect.objectContaining({
          type: 'doc',
        }),
      },
    });
  });

  it('routes the preview through JiraAdapter.updateTicket', async () => {
    const { adapter, jiraService } = createHarness();
    const updateTicketSpy = jest.spyOn(adapter, 'updateTicket');

    await captureJiraDescriptionUpdatePreview({
      ticketKey: 'WBP-3092',
      description: 'Preview update',
      adapter,
      jiraService,
    });

    expect(updateTicketSpy).toHaveBeenCalledWith('WBP-3092', expect.any(UniversalTicket));
  });

  it('loads the description file and returns preview diagnostics', async () => {
    const { adapter, jiraService } = createHarness();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-update-smoke-'));
    const descriptionFilePath = path.join(temporaryDirectory, 'ticket.md');

    fs.writeFileSync(descriptionFilePath, '### Summary\nLoad the ticket description from disk.\n', 'utf8');

    const result = await runJiraUpdateSmokeTest({
      ticketKey: 'WBP-3092',
      descriptionFilePath,
      executeLiveUpdate: false,
      adapter,
      jiraService,
    });

    expect(loadDescriptionFile(descriptionFilePath)).toBe('### Summary\nLoad the ticket description from disk.');
    expect(result.descriptionFilePath).toBe(descriptionFilePath);
    expect(result.payload.fields.description).toEqual(
      expect.objectContaining({
        type: 'doc',
      })
    );
  });

  it('strips the ticket preamble and starts the Jira description at summary', () => {
    const normalizedDescription = normalizeDescriptionMarkdown(
      [
        '# Remove static S3 credentials and grant ECS task role access to itinerary override bucket',
        '',
        '**Type:** bug',
        '**Priority:** medium',
        '',
        '## Description',
        '',
        '### Summary',
        '',
        'The real Jira description starts here.',
        '',
        '### Acceptance Criteria',
        '',
        '- First acceptance criterion',
      ].join('\n')
    );

    expect(normalizedDescription).toBe(
      [
        '### Summary',
        '',
        'The real Jira description starts here.',
        '',
        '### Acceptance Criteria',
        '',
        '- First acceptance criterion',
      ].join('\n')
    );
  });

  it('fails early when the description file is missing', () => {
    expect(() => loadDescriptionFile('/tmp/does-not-exist.md')).toThrow('Description file not found:');
  });
});
