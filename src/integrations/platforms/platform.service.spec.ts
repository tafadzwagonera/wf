import { ConfigService } from '@nestjs/config';
import { PlatformService } from './platform.service';
import type { PlatformAdapter } from './platform-adapter.interface';

const buildAdapter = (
  name: string,
  overrides: Partial<PlatformAdapter> = {},
): PlatformAdapter =>
  ({
    createTicket: jest.fn(),
    getTicket: jest.fn(),
    updateTicket: jest.fn(),
    supports: jest.fn(),
    getPlatformName: jest.fn().mockReturnValue(name),
    ...overrides,
  }) as unknown as PlatformAdapter;

describe('PlatformService', () => {
  const createConfigService = (
    values: Record<string, unknown>,
  ): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) =>
        key in values ? values[key] : defaultValue,
      ),
    }) as unknown as ConfigService;

  it('returns only pull-request discovery adapters with configured credentials', () => {
    const service = new PlatformService(
      createConfigService({
        'github.token': 'github-token',
        'atlassian.email': 'dev@example.com',
        'atlassian.bitbucket.apiToken': '',
      }),
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
