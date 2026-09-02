jest.mock('../../config/wf-config-loader', () => ({
  getLoadedWfConfig: jest.fn().mockReturnValue({ tracker: 'jira' }),
}));

import { ConfigService } from '@nestjs/config';
import { IssueTrackerService } from './issue-tracker.service';
import type { IssueTrackerAdapter } from './issue-tracker-adapter.interface';
import { getLoadedWfConfig } from '../../config/wf-config-loader';

const buildAdapter = (name: string, overrides: Partial<IssueTrackerAdapter> = {}): IssueTrackerAdapter =>
  ({
    createTicket: jest.fn(),
    getTicket: jest.fn(),
    updateTicket: jest.fn(),
    supports: jest.fn(),
    getTrackerName: jest.fn().mockReturnValue(name),
    ...overrides,
  }) as unknown as IssueTrackerAdapter;

describe('IssueTrackerService', () => {
  const createConfigService = (values: Record<string, unknown>): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue)),
    }) as unknown as ConfigService;

  it('getAdapter uses getLoadedWfConfig().tracker when no trackerName is passed', () => {
    const service = new IssueTrackerService(createConfigService({}));
    const jiraAdapter = buildAdapter('jira');
    const githubAdapter = buildAdapter('github');
    service.registerAdapter(jiraAdapter);
    service.registerAdapter(githubAdapter);

    (getLoadedWfConfig as jest.Mock).mockReturnValue({ tracker: 'github' });
    expect(service.getAdapter()).toBe(githubAdapter);

    (getLoadedWfConfig as jest.Mock).mockReturnValue({ tracker: 'jira' });
    expect(service.getAdapter()).toBe(jiraAdapter);
  });

  it('returns only pull-request discovery adapters with configured credentials', () => {
    const service = new IssueTrackerService(
      createConfigService({
        'github.token': 'github-token',
        'atlassian.email': 'dev@example.com',
        'atlassian.bitbucket.apiToken': '',
      })
    );
    const jiraAdapter = buildAdapter('jira');
    const githubAdapter = buildAdapter('github', {
      findPullRequestsByTicketKey: jest.fn(),
    });
    const bitbucketAdapter = buildAdapter('bitbucket', {
      findPullRequestsByTicketKey: jest.fn(),
    });

    service.registerAdapter(jiraAdapter);
    service.registerAdapter(githubAdapter);
    service.registerAdapter(bitbucketAdapter);

    const adapters = service.getPullRequestDiscoveryAdapters();

    expect([...adapters.keys()]).toEqual(['github']);
  });
});
