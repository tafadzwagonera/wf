import { Test } from '@nestjs/testing';
import { CommitterAgent } from './committer.agent';
import { GitService } from '../integrations/git/git.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';

describe('CommitterAgent', () => {
  it('delegates commit message generation to CommitStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        CommitterAgent,
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'] }),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            getRecentCommits: jest
              .fn()
              .mockResolvedValue([{ message: 'WBP-100: prior change' }]),
            commit: jest.fn().mockResolvedValue('abc123'),
          },
        },
        {
          provide: CommitStageService,
          useValue: {
            generateCommitMessage: jest
              .fn()
              .mockResolvedValue('WBP-123: restore login redirect'),
          },
        },
      ],
    }).compile();

    const agent = module.get(CommitterAgent);
    const commitStageService = module.get(CommitStageService);

    await agent.execute('WBP-123', '/tmp/repo', 'Fix login callback');

    expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      commitHistory: ['WBP-100: prior change'],
      ticketContext: 'Fix login callback',
    });
  });
});
