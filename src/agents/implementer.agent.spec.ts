import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ImplementerAgent } from './implementer.agent';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  PlanArtifact,
  TicketArtifact,
} from './interfaces';

describe('ImplementerAgent', () => {
  let agent: ImplementerAgent;
  let gitService: jest.Mocked<GitService>;
  let aiService: jest.Mocked<AiService>;

  const ticketArtifact: TicketArtifact = {
    ticketKey: 'WBP-1000',
    content: '# WBP-1000: Fix build verification\n',
    path: '/tmp/.wf/repo-a/jira/WBP-1000.md',
  };

  const buildPlan = (
    overrides?: Partial<PlanArtifact['plan']>,
  ): PlanArtifact => ({
    action: 'feature',
    path: '/tmp/.wf/repo-a/jira/WBP-1000-plan-feature.json',
    plan: {
      action: 'feature',
      summary: 'Implement verification',
      steps: ['Update source file'],
      estimatedComplexity: 'medium',
      filesAffected: ['repo-a/src/example.ts'],
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
            get: jest
              .fn()
              .mockImplementation((key: string, fallback?: unknown) => {
                const values: Record<string, unknown> = {
                  'branching.prefixMapping': {
                    feature: 'feature',
                    fix: 'bugfix',
                    investigate: 'chore',
                  },
                  'stages.implement.verificationConditions': {
                    policyFile: undefined,
                    scripts: {
                      formatWrite: 'npm run format:write',
                      formatCheck: 'npm run format:check',
                      lintFix: 'npm run lint:fix',
                      lint: 'npm run lint',
                      build: 'npm run build',
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
          },
        },
        {
          provide: AiService,
          useValue: {
            narrateImplementationPlan: jest
              .fn()
              .mockResolvedValue('## Goal\nShip a verified change\n'),
            generateFindings: jest.fn(),
          },
        },
      ],
    }).compile();

    agent = module.get(ImplementerAgent);
    gitService = module.get(GitService);
    aiService = module.get(AiService);

    jest
      .spyOn(require('fs'), 'mkdirSync')
      .mockImplementation(() => undefined as any);
    jest.spyOn(require('fs'), 'existsSync').mockImplementation(() => false);
    jest
      .spyOn(require('fs'), 'readFileSync')
      .mockImplementation((filePath: string) => {
        if (String(filePath).includes('package.json')) {
          return JSON.stringify({ scripts: {} });
        }
        throw new Error(`Unexpected read: ${filePath}`);
      });
    jest
      .spyOn(require('fs'), 'writeFileSync')
      .mockImplementation(() => undefined);
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
        verificationScripts: [{ id: 'lint', command: 'npm run lint' }],
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
            filesAffected: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a', 'repo-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          },
        ),
      ).rejects.toThrow(
        'issue:implement only verifies a single repository. This plan affects multiple repositories: repo-a, repo-b. Use wf issue or run wf issue:implement separately per repository.',
      );
    });

    it('fails when filesAffected include a different repo prefix than the selected repo', async () => {
      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            filesAffected: ['repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          },
        ),
      ).rejects.toThrow(
        'issue:implement can only modify and verify files for repo-a. Found paths for other repositories: repo-b/src/example.ts. Use wf issue or run wf issue:implement separately per repository.',
      );
    });

    it('allowMultiRepoScope bypasses the multi-repo count guard', async () => {
      jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            filesAffected: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            repositoriesAffected: ['repo-a', 'repo-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            allowMultiRepoScope: true,
          },
        ),
      ).resolves.not.toThrow();
    });

    it('allowMultiRepoScope bypasses the offending-paths guard', async () => {
      jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            filesAffected: ['repo-b/src/x.ts'],
            repositoriesAffected: ['repo-a'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            allowMultiRepoScope: true,
          },
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('custom branch slug', () => {
    it('uses the custom branch slug when provided for non-ticket execution contexts', async () => {
      jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);

      await agent.execute(ticketArtifact, buildPlan({ filesAffected: [] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        customBranchSlug: 'dark-building-creek',
      });

      expect(gitService.createBranch).toHaveBeenCalledWith(
        'feature/dark-building-creek',
        undefined,
        '/tmp/repo-a',
      );
    });
  });

  describe('agent backend delegation', () => {
    it('delegates to AnthropicAgentAdapter when provider is anthropic', async () => {
      const adapterSpy = jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);

      await agent.execute(
        ticketArtifact,
        buildPlan({ filesAffected: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a' },
      );

      expect(adapterSpy).toHaveBeenCalledTimes(1);
    });

    it('logs the selected anthropic-agent backend', async () => {
      jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue(undefined);

      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({ filesAffected: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a' },
      );

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('Implement backend: anthropic-agent'),
        ),
      ).toBe(true);
    });

    it('fails fast when provider is unsupported', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: ConfigService,
            useValue: {
              get: jest
                .fn()
                .mockImplementation((key: string, fallback?: unknown) => {
                  if (key === 'stages.implement.provider') return 'google';
                  if (key === 'ai.provider') return 'google';
                  if (key === 'branching.prefixMapping')
                    return {
                      feature: 'feature',
                      fix: 'bugfix',
                      investigate: 'chore',
                    };
                  if (key === 'stages.implement.verificationConditions')
                    return undefined;
                  return fallback;
                }),
            },
          },
          {
            provide: GitService,
            useValue: {
              getCurrentBranch: jest.fn().mockResolvedValue('main'),
              createBranch: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: AiService,
            useValue: {
              narrateImplementationPlan: jest
                .fn()
                .mockResolvedValue('## Goal\nFallback\n'),
              generateFindings: jest.fn(),
            },
          },
        ],
      }).compile();

      const googleAgent = module.get(ImplementerAgent);

      await expect(
        googleAgent.execute(
          ticketArtifact,
          buildPlan({ filesAffected: ['repo-a/src/example.ts'] }),
          { trackerName: 'jira', repoDir: '/tmp/repo-a' },
        ),
      ).rejects.toThrow(
        'Implement stage requires provider "anthropic" or "openai". Got "google".',
      );
    });

    it('delegates to OpenAIAgentAdapter when provider is openai', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: ConfigService,
            useValue: {
              get: jest
                .fn()
                .mockImplementation((key: string, fallback?: unknown) => {
                  if (key === 'stages.implement.provider') return 'openai';
                  if (key === 'ai.provider') return 'anthropic';
                  if (key === 'branching.prefixMapping')
                    return {
                      feature: 'feature',
                      fix: 'bugfix',
                      investigate: 'chore',
                    };
                  if (key === 'stages.implement.verificationConditions')
                    return undefined;
                  return fallback;
                }),
            },
          },
          {
            provide: GitService,
            useValue: {
              getCurrentBranch: jest.fn().mockResolvedValue('main'),
              createBranch: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: AiService,
            useValue: {
              narrateImplementationPlan: jest
                .fn()
                .mockResolvedValue('## Goal\nOpenAI\n'),
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
        .mockImplementation((p: string) =>
          ['/tmp/repo-a/package.json', '/tmp/repo-a/src/example.ts'].includes(
            p,
          ),
        );
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockImplementation((p: string) => {
          if (p === '/tmp/repo-a/package.json')
            return JSON.stringify({ scripts: {} });
          return 'export const x = 0;\n';
        });
      jest
        .spyOn(require('fs'), 'mkdirSync')
        .mockImplementation(() => undefined as any);
      jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => undefined);

      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await openaiAgent.execute(
        ticketArtifact,
        buildPlan({ filesAffected: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a' },
      );

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('Implement backend: openai-agent'),
        ),
      ).toBe(true);
      expect(openaiAdapterSpy).toHaveBeenCalledTimes(1);
    });
  });
});
