import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BitBucketAdapter } from './bitbucket-adapter';
import { LoggerService } from '../../../shared/logger/logger.service';
import { PlatformConfigService } from '../platform-config.service';

describe('BitBucketAdapter', () => {
  let adapter: BitBucketAdapter;
  let mockPullrequestsCreateComment: jest.Mock;

  beforeEach(async () => {
    mockPullrequestsCreateComment = jest.fn().mockResolvedValue({ data: {} });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BitBucketAdapter,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'atlassian.email') return 'test@example.com';
              if (key === 'atlassian.bitbucket.apiToken') return 'token';
              if (key === 'atlassian.bitbucket.workspace')
                return 'testworkspace';
              return undefined;
            },
          },
        },
        {
          provide: LoggerService,
          useValue: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        },
        {
          provide: PlatformConfigService,
          useValue: { isPlatformEnabled: jest.fn().mockReturnValue(true) },
        },
      ],
    }).compile();

    adapter = module.get<BitBucketAdapter>(BitBucketAdapter);

    // Replace the Bitbucket client after construction so all SDK calls go through mocks
    (adapter as any).bitbucket = {
      pullrequests: { createComment: mockPullrequestsCreateComment },
    };
  });

  describe('createComment', () => {
    it('posts a PR comment with content.raw but without the type discriminator', async () => {
      const prUrl =
        'https://bitbucket.org/testworkspace/testrepo/pull-requests/42';
      const body = '## AI Code Review\n\n**Summary:** Looks good.';

      await adapter.createComment(prUrl, body);

      expect(mockPullrequestsCreateComment).toHaveBeenCalledWith({
        workspace: 'testworkspace',
        repo_slug: 'testrepo',
        pull_request_id: 42,
        _body: { content: { raw: body } },
      });
    });

    it('does not include the type discriminator in PR comment _body', async () => {
      const prUrl =
        'https://bitbucket.org/testworkspace/testrepo/pull-requests/7';

      await adapter.createComment(prUrl, 'test comment');

      const call = mockPullrequestsCreateComment.mock.calls[0][0];
      expect(call._body).not.toHaveProperty('type');
    });
  });

  describe('createInlineComment', () => {
    it('posts an inline PR comment without the type discriminator in _body', async () => {
      const prUrl =
        'https://bitbucket.org/testworkspace/testrepo/pull-requests/42';

      await adapter.createInlineComment(prUrl, 'src/foo.ts', 10, 'inline note');

      const call = mockPullrequestsCreateComment.mock.calls[0][0];
      expect(call._body).not.toHaveProperty('type');
      expect(call._body.inline).toEqual({ path: 'src/foo.ts', to: 10 });
      expect(call._body.content.raw).toBe('inline note');
    });
  });
});
