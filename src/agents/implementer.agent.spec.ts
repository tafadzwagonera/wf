import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ImplementerAgent } from './implementer.agent';
import { GitService } from '../integrations/git/git.service';
import { GitError } from '../shared/errors/app.error';
import { AiService } from '../integrations/ai/ai.service';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import type { ImplementBackendSelection, ImplementRunArtifact, PlanArtifact, TicketArtifact } from './interfaces';

describe('ImplementerAgent', () => {
  let agent: ImplementerAgent;
  let gitService: jest.Mocked<GitService>;
  let aiService: jest.Mocked<AiService>;

  const ticketArtifact: TicketArtifact = {
    ticketKey: 'WBP-1000',
    content: '# WBP-1000: Fix build verification\n',
    path: '/tmp/.wf/repo-a/jira/WBP-1000.md',
  };

  const buildPlan = (overrides?: Partial<PlanArtifact['plan']>): PlanArtifact => ({
    action: 'feature',
    path: '/tmp/.wf/repo-a/jira/WBP-1000-plan-feature.json',
    plan: {
      action: 'feature',
      summary: 'Implement verification',
      steps: ['Update source file'],
      estimatedComplexity: 'medium',
      affectedFiles: ['repo-a/src/example.ts'],
      repositoriesAffected: ['repo-a'],
      ...overrides,
    },
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ImplementerAgent,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
              const values: Record<string, unknown> = {
                'git.branchPrefixMapping': {
                  feature: 'feature',
                  fix: 'bugfix',
                  investigate: 'chore',
                },
                'stages.implement.verificationConditions': {
                  policyFile: undefined,
                  scripts: {
                    formatWrite: 'yarn format:write',
                    formatCheck: 'yarn format:check',
                    lintFix: 'yarn lint:fix',
                    lint: 'yarn lint',
                    build: 'yarn build',
                  },
                },
                'stages.implement.provider': 'anthropic',
              };

              return key in values ? values[key] : fallback;
            }),
          },
        },
        {
          provide: GitService,
          useValue: {
            getCurrentBranch: jest.fn().mockResolvedValue('main'),
            createBranch: jest.fn().mockResolvedValue(undefined),
            getStatus: jest.fn().mockResolvedValue({
              isClean: () => true,
              modified: [],
              staged: [],
              deleted: [],
              renamed: [],
              conflicted: [],
              not_added: [],
            }),
            getBranchInfo: jest.fn().mockResolvedValue({
              current: 'main',
              all: ['main', 'develop'],
              development: 'develop',
              isClean: true,
              hasUncommittedChanges: false,
            }),
            detectDevelopmentBranches: jest.fn().mockReturnValue(['develop']),
            detectMainBranch: jest.fn().mockReturnValue('main'),
            hasUpstream: jest.fn().mockResolvedValue(true),
            checkoutBranch: jest.fn().mockResolvedValue(undefined),
            pull: jest.fn().mockResolvedValue(undefined),
            stashChanges: jest.fn().mockResolvedValue(undefined),
            stashPop: jest.fn().mockResolvedValue(undefined),
            checkIgnored: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AiService,
          useValue: {
            generateFindings: jest.fn(),
          },
        },
      ],
    }).compile();

    agent = module.get(ImplementerAgent);
    gitService = module.get(GitService);
    aiService = module.get(AiService);

    jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined as any);
    jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
      const s = String(p);
      // Allow planned file paths to pass the existence check while keeping
      // infrastructure files (verification manifests, .wf/, etc.) as non-existent.
      return s.startsWith('/tmp/repo-a/src/') || s.startsWith('/tmp/repo-a/docs/') || s.endsWith('/package.json');
    });
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((filePath: string) => {
      if (String(filePath).includes('package.json')) {
        return JSON.stringify({ scripts: {} });
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });
    jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('shared verification contracts', () => {
    it('accepts backend selection and verification artifact shapes', () => {
      const mockBackendSelection: ImplementBackendSelection = {
        configured: 'anthropic-agent',
        selected: 'anthropic-agent',
        provider: 'anthropic',
      };
      const mockRunArtifact: ImplementRunArtifact = {
        ticketKey: 'WBP-1000',
        repoDir: '/tmp/repo-a',
        backendConfigured: mockBackendSelection.configured,
        backendSelected: mockBackendSelection.selected,
        provider: mockBackendSelection.provider,
        verificationScripts: [{ id: 'lint', command: 'yarn lint' }],
        startedAt: new Date().toISOString(),
      };

      expect(mockBackendSelection.selected).toBe('anthropic-agent');
      expect(mockRunArtifact.backendConfigured).toBe('anthropic-agent');
    });
  });

  describe('single-repo boundary', () => {
    it('fails when the plan spans multiple repositories', async () => {
      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a', 'repo-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).rejects.toThrow(
        'issue:implement only verifies a single repository. This plan affects multiple repositories: repo-a, repo-b. Use wf issue or run wf issue:implement separately per repository.'
      );
    });

    it('fails when affectedFiles include a different repo prefix than the selected repo', async () => {
      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).rejects.toThrow(
        'issue:implement can only modify and verify files for repo-a. Found paths for other repositories: repo-b/src/example.ts. Use wf issue or run wf issue:implement separately per repository.'
      );
    });

    it('allowMultiRepoScope bypasses the multi-repo count guard', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a', 'repo-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            allowMultiRepoScope: true,
          }
        )
      ).resolves.not.toThrow();
    });

    it('allowMultiRepoScope bypasses the offending-paths guard', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-b/src/x.ts'],
            repositoriesAffected: ['repo-a'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            allowMultiRepoScope: true,
          }
        )
      ).resolves.not.toThrow();
    });
  });

  describe('custom branch slug', () => {
    it('uses the custom branch slug when provided for non-ticket execution contexts', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: [] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        customBranchSlug: 'dark-building-creek',
      });

      expect(gitService.createBranch).toHaveBeenCalledWith('feature/dark-building-creek', 'develop', '/tmp/repo-a');
    });
  });

  describe('agent backend delegation', () => {
    it('delegates to AnthropicAgentAdapter when provider is anthropic', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
    });

    it('logs the selected anthropic-agent backend', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Implement backend: anthropic-agent'))).toBe(true);
    });

    it('fails fast when provider is unsupported', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
                if (key === 'stages.implement.provider') return 'google';
                if (key === 'ai.provider') return 'google';
                if (key === 'git.branchPrefixMapping')
                  return {
                    feature: 'feature',
                    fix: 'bugfix',
                    investigate: 'chore',
                  };
                if (key === 'stages.implement.verificationConditions') return undefined;
                return fallback;
              }),
            },
          },
          {
            provide: GitService,
            useValue: {
              getCurrentBranch: jest.fn().mockResolvedValue('main'),
              createBranch: jest.fn().mockResolvedValue(undefined),
              getStatus: jest.fn().mockResolvedValue({
                isClean: () => true,
                modified: [],
                staged: [],
                deleted: [],
                renamed: [],
                conflicted: [],
                not_added: [],
              }),
              getBranchInfo: jest.fn().mockResolvedValue({
                current: 'main',
                all: ['main', 'develop'],
                development: 'develop',
                isClean: true,
                hasUncommittedChanges: false,
              }),
              detectDevelopmentBranches: jest.fn().mockReturnValue(['develop']),
              detectMainBranch: jest.fn().mockReturnValue('main'),
              hasUpstream: jest.fn().mockResolvedValue(true),
              checkoutBranch: jest.fn().mockResolvedValue(undefined),
              pull: jest.fn().mockResolvedValue(undefined),
              stashChanges: jest.fn().mockResolvedValue(undefined),
              stashPop: jest.fn().mockResolvedValue(undefined),
              checkIgnored: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: AiService,
            useValue: {
              generateFindings: jest.fn(),
            },
          },
        ],
      }).compile();

      const googleAgent = module.get(ImplementerAgent);

      await expect(
        googleAgent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
        })
      ).rejects.toThrow('Implement stage requires provider "anthropic" or "openai". Got "google".');
    });

    it('delegates to OpenAIAgentAdapter when provider is openai', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
                if (key === 'stages.implement.provider') return 'openai';
                if (key === 'ai.provider') return 'anthropic';
                if (key === 'git.branchPrefixMapping')
                  return {
                    feature: 'feature',
                    fix: 'bugfix',
                    investigate: 'chore',
                  };
                if (key === 'stages.implement.verificationConditions') return undefined;
                return fallback;
              }),
            },
          },
          {
            provide: GitService,
            useValue: {
              getCurrentBranch: jest.fn().mockResolvedValue('main'),
              createBranch: jest.fn().mockResolvedValue(undefined),
              getStatus: jest.fn().mockResolvedValue({
                isClean: () => true,
                modified: [],
                staged: [],
                deleted: [],
                renamed: [],
                conflicted: [],
                not_added: [],
              }),
              getBranchInfo: jest.fn().mockResolvedValue({
                current: 'main',
                all: ['main', 'develop'],
                development: 'develop',
                isClean: true,
                hasUncommittedChanges: false,
              }),
              detectDevelopmentBranches: jest.fn().mockReturnValue(['develop']),
              detectMainBranch: jest.fn().mockReturnValue('main'),
              hasUpstream: jest.fn().mockResolvedValue(true),
              checkoutBranch: jest.fn().mockResolvedValue(undefined),
              pull: jest.fn().mockResolvedValue(undefined),
              stashChanges: jest.fn().mockResolvedValue(undefined),
              stashPop: jest.fn().mockResolvedValue(undefined),
              checkIgnored: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: AiService,
            useValue: {
              generateFindings: jest.fn(),
            },
          },
        ],
      }).compile();

      const openaiAgent = module.get(ImplementerAgent);
      const openaiAdapterSpy = jest
        .spyOn(OpenAIAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((p: string) => ['/tmp/repo-a/package.json', '/tmp/repo-a/src/example.ts'].includes(p));
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((p: string) => {
        if (p === '/tmp/repo-a/package.json') return JSON.stringify({ scripts: {} });
        return 'export const x = 0;\n';
      });
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined as any);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await openaiAgent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Implement backend: openai-agent'))).toBe(true);
      expect(openaiAdapterSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('branch workflow', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('auto-stashes when working tree is dirty in silent mode', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
      } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.stashChanges).toHaveBeenCalledWith(expect.any(String), '/tmp/repo-a');
      expect(gitService.stashPop).toHaveBeenCalledWith('/tmp/repo-a');
    });

    it('throws when working tree has unresolved merge conflicts', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: [],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: ['.gitignore'],
        not_added: [],
      } as any);

      await expect(
        agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
          silent: true,
        })
      ).rejects.toThrow('unresolved merge conflicts');

      expect(gitService.stashChanges).not.toHaveBeenCalled();
    });

    it('skips stash when only untracked files are present', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: [],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: ['.wf/state/session.json'],
      } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.stashChanges).not.toHaveBeenCalled();
      expect(gitService.stashPop).not.toHaveBeenCalled();
    });

    it('skips stash when working tree is clean', async () => {
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.stashChanges).not.toHaveBeenCalled();
      expect(gitService.stashPop).not.toHaveBeenCalled();
    });

    it('auto-selects dev branch in silent mode', async () => {
      gitService.detectDevelopmentBranches.mockReturnValue(['develop']);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.checkoutBranch).toHaveBeenCalledWith('develop', '/tmp/repo-a');
      expect(gitService.pull).toHaveBeenCalledWith('origin', 'develop', '/tmp/repo-a');
    });

    it('falls back to main when no dev branch exists', async () => {
      gitService.detectDevelopmentBranches.mockReturnValue([]);
      gitService.detectMainBranch.mockReturnValue('main');
      gitService.getBranchInfo.mockResolvedValue({
        current: 'main',
        all: ['main'],
        development: undefined,
        isClean: true,
        hasUncommittedChanges: false,
      });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.pull).toHaveBeenCalledWith('origin', 'main', '/tmp/repo-a');
    });

    it('skips pull when source branch is a remote ref', async () => {
      gitService.detectDevelopmentBranches.mockReturnValue(['remotes/origin/develop']);
      gitService.getBranchInfo.mockResolvedValue({
        current: 'main',
        all: ['main', 'remotes/origin/develop'],
        development: 'remotes/origin/develop',
        isClean: true,
        hasUncommittedChanges: false,
      });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.pull).not.toHaveBeenCalled();
      expect(gitService.checkoutBranch).not.toHaveBeenCalled();
      expect(gitService.createBranch).toHaveBeenCalledWith(expect.any(String), 'remotes/origin/develop', '/tmp/repo-a');
    });

    it('does not create branch when --no-branch is set', async () => {
      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(result).toEqual({ type: 'implementation', branchName: null });
    });

    it('warns and continues when pull fails (no upstream)', async () => {
      gitService.pull.mockRejectedValue(new Error('no upstream'));

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      // Should not throw — pull failure is non-fatal
      expect(gitService.createBranch).toHaveBeenCalled();
    });

    it('stash failure propagates GitError', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
      } as any);
      gitService.stashChanges.mockRejectedValue(new GitError('Failed to stash changes'));

      await expect(
        agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
          silent: true,
        })
      ).rejects.toThrow('Failed to stash changes');
    });

    it('stash pop conflict logs warning and continues', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
      } as any);
      gitService.stashPop.mockRejectedValue(new Error('CONFLICT'));

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      // Should not throw — stash pop conflict is non-fatal
      expect(gitService.stashPop).toHaveBeenCalledWith('/tmp/repo-a');
      expect(gitService.createBranch).toHaveBeenCalled();
    });
  });

  describe('tracked file validation', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('drops gitignored paths from trackedFilePaths and repoFiles', async () => {
      gitService.checkIgnored.mockResolvedValue(['/tmp/repo-a/docs/incidents/report.md']);

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts', 'repo-a/docs/incidents/report.md'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.trackedFilePaths).toEqual(['/tmp/repo-a/src/example.ts']);
      expect(call.trackedFilePaths).not.toContainEqual(expect.stringContaining('docs/incidents'));
      // repoFiles should also be filtered so the continuation loop
      // does not chase gitignored paths
      expect(call.repoFiles).toEqual(['repo-a/src/example.ts']);
    });

    it('warns when gitignored paths are dropped', async () => {
      gitService.checkIgnored.mockResolvedValue(['/tmp/repo-a/docs/incidents/report.md']);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts', 'repo-a/docs/incidents/report.md'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(msg => msg.includes('gitignored'))).toBe(true);
    });

    it('passes all paths through when none are gitignored', async () => {
      gitService.checkIgnored.mockResolvedValue([]);

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/a.ts', 'repo-a/src/b.ts'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.trackedFilePaths).toEqual(['/tmp/repo-a/src/a.ts', '/tmp/repo-a/src/b.ts']);
    });
  });

  describe('affectedFilesContext / contextFiles', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('passes contextFiles to adapter when affectedFilesContext is present', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedFilesContext: [{ filePath: 'repo-a/package.json', status: 'found' }],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.contextFiles).toEqual(['repo-a/package.json']);
    });

    it('passes empty contextFiles when affectedFilesContext is absent', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const call = adapterSpy.mock.calls[0][0];
      expect(call.contextFiles).toEqual([]);
    });

    it('deduplicates contextFiles that overlap with repoFiles', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedFilesContext: [
            { filePath: 'repo-a/src/example.ts', status: 'found' },
            { filePath: 'repo-a/package.json', status: 'found' },
          ],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.contextFiles).toEqual(['repo-a/package.json']);
    });

    it('filters out not-found entries from contextFiles', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedFilesContext: [
            { filePath: 'repo-a/package.json', status: 'found' },
            { filePath: 'repo-a/missing.ts', status: 'not-found' },
          ],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.contextFiles).toEqual(['repo-a/package.json']);
    });

    it('normalizes legacy string[] affectedFiles to FileEntry[]', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedFilesContext: ['repo-a/package.json'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.repoFiles).toEqual(['repo-a/src/example.ts']);
      expect(call.contextFiles).toEqual(['repo-a/package.json']);
    });

    it('removes nonexistent repoFiles and warns about hallucinated paths', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => String(p).includes('real-file.ts'));

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: [
            { filePath: 'repo-a/src/real-file.ts', status: 'found' },
            { filePath: 'repo-a/src/phantom.ts', status: 'found' },
          ],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.repoFiles).toEqual(['repo-a/src/real-file.ts']);
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('nonexistent path'))).toBe(true);
      expect(logCalls.some(msg => msg.includes('phantom.ts'))).toBe(true);
    });

    it('keeps to-create entries even when file does not exist', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation(() => false);

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: [{ filePath: 'repo-a/src/new-file.ts', status: 'to-create' }],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.repoFiles).toEqual(['repo-a/src/new-file.ts']);
    });

    it('removes nonexistent context files and warns', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => String(p).includes('real-config.json'));

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: [{ filePath: 'repo-a/src/real-config.json', status: 'found' }],
          affectedFilesContext: [
            { filePath: 'repo-a/real-config.json', status: 'found' },
            { filePath: 'repo-a/phantom-ctx.ts', status: 'found' },
          ],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.contextFiles).not.toContainEqual(expect.stringContaining('phantom-ctx'));
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('nonexistent context file'))).toBe(true);
    });

    it('warns when repoFiles is empty after filtering', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation(() => false);

      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: [] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('No planned files to implement'))).toBe(true);
    });
  });
});
