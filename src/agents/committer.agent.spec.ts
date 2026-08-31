import { Test } from '@nestjs/testing';
import { CommitterAgent } from './committer.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';

describe('CommitterAgent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('delegates commit message generation to CommitStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        CommitterAgent,
        {
          provide: CliPresenter,
          useValue: {
            stageHeader: jest.fn(),
            separator: jest.fn(),
            progress: jest.fn(),
            outcome: jest.fn(),
            detail: jest.fn(),
            summaryBlock: jest.fn(),
          },
        },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: [] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            getRecentCommits: jest.fn().mockResolvedValue([{ message: 'WBP-100: prior change' }]),
            commit: jest.fn().mockResolvedValue('abc123'),
          },
        },
        {
          provide: CommitStageService,
          useValue: {
            generateCommitMessage: jest.fn().mockResolvedValue('WBP-123: restore login redirect'),
          },
        },
      ],
    }).compile();

    const agent = module.get(CommitterAgent);
    const commitStageService = module.get(CommitStageService);
    const gitService = module.get(GitService);

    await agent.execute('WBP-123', '/tmp/repo', 'Fix login callback');

    expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      commitHistory: ['WBP-100: prior change'],
      ticketContext: 'Fix login callback',
    });
    expect(gitService.stageAll).toHaveBeenCalled();
  });

  it('does not widen an already-scoped stage by calling stageAll when files are already staged', async () => {
    const module = await Test.createTestingModule({
      providers: [
        CommitterAgent,
        {
          provide: CliPresenter,
          useValue: {
            stageHeader: jest.fn(),
            separator: jest.fn(),
            progress: jest.fn(),
            outcome: jest.fn(),
            detail: jest.fn(),
            summaryBlock: jest.fn(),
          },
        },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            getRecentCommits: jest.fn().mockResolvedValue([]),
            commit: jest.fn().mockResolvedValue('abc123'),
          },
        },
        {
          provide: CommitStageService,
          useValue: {
            generateCommitMessage: jest.fn().mockResolvedValue('WBP-123: restore login redirect'),
          },
        },
      ],
    }).compile();

    const agent = module.get(CommitterAgent);
    const gitService = module.get(GitService);

    await agent.execute('WBP-123', '/tmp/repo');

    expect(gitService.stageAll).not.toHaveBeenCalled();
  });
});
