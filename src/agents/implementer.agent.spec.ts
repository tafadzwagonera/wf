import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import inquirer from 'inquirer';
import { ImplementerAgent } from './implementer.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { GitError, InvalidBranchNameError } from '../shared/errors/app.error';
import { appendToLogFile } from '../shared/logger/log-file-writer';
import { AiService } from '../integrations/ai/ai.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { PlanStepVerificationService } from './plan-step-verification.service';
import { StepSpecFidelityService } from './step-spec-fidelity.service';
import { FigmaStageService } from '../review/figma-stage.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import type { ImplementBackendSelection, ImplementRunArtifact, PlanArtifact, TicketArtifact } from './interfaces';
import { KNOWN_SKILLS, registerSkill } from '../skills/skill-registry';
import { isRepoResolvable } from './utils';
import * as detectRepoConventionsModule from '../shared/utils/detect-repo-conventions';
import { updatePlanArtifactManifestSourceBranch } from '../shared/utils/plan-artifact';

jest.mock('inquirer');

jest.mock('../shared/logger/log-file-writer');

jest.mock('../shared/utils/plan-artifact', () => {
  const actual = jest.requireActual('../shared/utils/plan-artifact');
  return { ...actual, updatePlanArtifactManifestSourceBranch: jest.fn() };
});

jest.mock('./utils', () => {
  const actual = jest.requireActual('./utils');
  return { ...actual, isRepoResolvable: jest.fn(() => true) };
});

jest.mock('../shared/utils/post-pull-install', () => ({
  runPostPullDependencyInstall: jest.fn().mockResolvedValue(undefined),
}));

const createMockPresenter = () => ({
  stageHeader: jest.fn(),
  separator: jest.fn(),
  progress: jest.fn(),
  outcome: jest.fn(),
  detail: jest.fn(),
  summaryBlock: jest.fn(),
});

describe('ImplementerAgent', () => {
  let agent: ImplementerAgent;
  let gitService: jest.Mocked<GitService>;
  let aiService: jest.Mocked<AiService>;
  let presenter: ReturnType<typeof createMockPresenter>;
  let configService: ConfigService;
  let planStepVerificationService: { run: jest.Mock; logSkip: jest.Mock };
  let stepSpecFidelityService: { run: jest.Mock; verifyAll: jest.Mock };
  let mockIsRepoResolvable: jest.MockedFunction<typeof isRepoResolvable>;

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
      affectedRepositories: ['repo-a'],
      ...overrides,
    },
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ImplementerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
              files: [],
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
            getRecentCommits: jest.fn().mockResolvedValue([
              { hash: 'baseline-sha', message: 'baseline commit', author: 'tester', date: new Date('2024-01-01') },
            ]),
            resetSoftToCommit: jest.fn().mockResolvedValue(undefined),
            listCommitsInRange: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AiService,
          useValue: {
            generateFindings: jest.fn(),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(false),
            chatTurn: jest.fn(),
            logResolvedStageTarget: jest.fn(),
          },
        },
        {
          provide: PlanStepVerificationService,
          useValue: {
            run: jest.fn().mockImplementation(async (params: { refreshSteps?: () => Promise<unknown> }) => {
              await params.refreshSteps?.();
              return { sessionId: undefined, summary: undefined, extraPassCount: 0 };
            }),
            logSkip: jest.fn(),
          },
        },
        {
          provide: StepSpecFidelityService,
          useValue: {
            run: jest.fn().mockResolvedValue([]),
            verifyAll: jest.fn().mockResolvedValue([[]]),
          },
        },
        {
          provide: FigmaStageService,
          useValue: {
            resolveIfEnabled: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    agent = module.get(ImplementerAgent);
    presenter = module.get(CliPresenter);
    gitService = module.get(GitService);
    aiService = module.get(AiService);
    configService = module.get(ConfigService);
    planStepVerificationService = module.get(PlanStepVerificationService);
    stepSpecFidelityService = module.get(StepSpecFidelityService);
    mockIsRepoResolvable = isRepoResolvable as jest.MockedFunction<typeof isRepoResolvable>;

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
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('fails when the plan spans multiple repositories', async () => {
      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            affectedRepositories: ['repo-a', 'repo-b'],
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
            affectedRepositories: ['repo-a'],
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
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            affectedRepositories: ['repo-a', 'repo-b'],
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
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-b/src/x.ts'],
            affectedRepositories: ['repo-a'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            allowMultiRepoScope: true,
          }
        )
      ).resolves.not.toThrow();
    });

    it('passes when non-existent repos reduce local count to one', async () => {
      mockIsRepoResolvable.mockImplementation(repo => repo === 'repo-a');
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts'],
            affectedRepositories: ['repo-a', 'nonexistent-repo'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).resolves.not.toThrow();
    });

    it('passes when affectedFiles reference an unresolvable repo prefix', async () => {
      mockIsRepoResolvable.mockImplementation(repo => repo === 'repo-a');
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'nonexistent-repo/src/index.ts'],
            affectedRepositories: ['repo-a', 'nonexistent-repo'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).resolves.not.toThrow();
    });

    it('passes when all repos are non-existent (zero local repos)', async () => {
      mockIsRepoResolvable.mockReturnValue(false);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['nonexistent-a/src/a.ts', 'nonexistent-b/src/b.ts'],
            affectedRepositories: ['nonexistent-a', 'nonexistent-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).resolves.not.toThrow();
    });

    it('still fails when multiple repos exist locally without allowMultiRepoScope', async () => {
      mockIsRepoResolvable.mockReturnValue(true);

      await expect(
        agent.execute(
          ticketArtifact,
          buildPlan({
            affectedFiles: ['repo-a/src/example.ts', 'repo-b/src/example.ts'],
            affectedRepositories: ['repo-a', 'repo-b'],
          }),
          {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
          }
        )
      ).rejects.toThrow('issue:implement only verifies a single repository');
    });
  });

  describe('custom branch slug', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('uses the custom branch slug when provided for non-ticket execution contexts', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: [] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        customBranchSlug: 'dark-building-creek',
      });

      expect(gitService.createBranch).toHaveBeenCalledWith(
        'feature/dark-building-creek',
        expect.objectContaining({ baseBranch: 'develop', cwd: '/tmp/repo-a' })
      );
    });

    it('records the resolved source branch onto the plan manifest', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      const plan = buildPlan({ affectedFiles: [] });

      await agent.execute(ticketArtifact, plan, {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        customBranchSlug: 'dark-building-creek',
      });

      expect(updatePlanArtifactManifestSourceBranch).toHaveBeenCalledWith(
        plan.path, 'develop', 'feature/dark-building-creek'
      );
    });

    it('also records the source branch when reusing an already-checked-out branch', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      gitService.getCurrentBranch.mockResolvedValue('feature/dark-building-creek');
      const plan = buildPlan({ affectedFiles: [] });

      await agent.execute(ticketArtifact, plan, {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        customBranchSlug: 'dark-building-creek',
      });

      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(updatePlanArtifactManifestSourceBranch).toHaveBeenCalledWith(
        plan.path, 'develop', 'feature/dark-building-creek'
      );
    });
  });

  describe('agent backend delegation', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('delegates to AnthropicAgentAdapter when provider is anthropic', async () => {
      const adapterSpy = jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
    });

    it('logs the selected anthropic-agent backend', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Implement backend: anthropic-agent'))).toBe(true);
    });

    it('includes verificationOutcomes from adapter in the returned ImplementerResult', async () => {
      const mockOutcomes = [
        { id: 'lint', command: 'yarn lint', policy: 'enforced' as const, status: 'passed' as const },
      ];
      jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: 'sess-abc', verificationOutcomes: mockOutcomes });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true }
      );

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.verificationOutcomes).toEqual(mockOutcomes);
        expect(result.sessionId).toBe('sess-abc');
      }
    });

    it('fails fast when provider is unsupported', async () => {
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: CliPresenter,
            useValue: createMockPresenter(),
          },
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
                files: [],
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
              getRecentCommits: jest.fn().mockResolvedValue([
                { hash: 'baseline-sha', message: 'baseline commit', author: 'tester', date: new Date('2024-01-01') },
              ]),
              resetSoftToCommit: jest.fn().mockResolvedValue(undefined),
              listCommitsInRange: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: AiService,
            useValue: {
              generateFindings: jest.fn(),
            },
          },
          {
            provide: StageAgentService,
            useValue: {
              isEnabledForStage: jest.fn().mockReturnValue(false),
              chatTurn: jest.fn(),
              logResolvedStageTarget: jest.fn(),
            },
          },
          {
            provide: PlanStepVerificationService,
            useValue: {
              run: jest.fn().mockResolvedValue({ sessionId: undefined, summary: undefined, extraPassCount: 0 }),
            },
          },
          {
            provide: StepSpecFidelityService,
            useValue: {
              run: jest.fn().mockResolvedValue([]),
              verifyAll: jest.fn().mockResolvedValue({ findingsPerStep: new Map([[0, []]]), failures: [] }),
            },
          },
          { provide: FigmaStageService, useValue: { resolveIfEnabled: jest.fn().mockResolvedValue(undefined) } },
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
            provide: CliPresenter,
            useValue: createMockPresenter(),
          },
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
                files: [],
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
              getRecentCommits: jest.fn().mockResolvedValue([
                { hash: 'baseline-sha', message: 'baseline commit', author: 'tester', date: new Date('2024-01-01') },
              ]),
              resetSoftToCommit: jest.fn().mockResolvedValue(undefined),
              listCommitsInRange: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: AiService,
            useValue: {
              generateFindings: jest.fn(),
            },
          },
          {
            provide: StageAgentService,
            useValue: {
              isEnabledForStage: jest.fn().mockReturnValue(false),
              chatTurn: jest.fn(),
              logResolvedStageTarget: jest.fn(),
            },
          },
          {
            provide: PlanStepVerificationService,
            useValue: {
              run: jest.fn().mockResolvedValue({ sessionId: undefined, summary: undefined, extraPassCount: 0 }),
            },
          },
          {
            provide: StepSpecFidelityService,
            useValue: {
              run: jest.fn().mockResolvedValue([]),
              verifyAll: jest.fn().mockResolvedValue({ findingsPerStep: new Map([[0, []]]), failures: [] }),
            },
          },
          { provide: FigmaStageService, useValue: { resolveIfEnabled: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      const openaiAgent = module.get(ImplementerAgent);
      const openaiAdapterSpy = jest
        .spyOn(OpenAIAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
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

  describe('hasChanges derivation', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('runBackend returns hasChanges: true when git status reports files', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/a.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        created: [],
        files: [{ path: 'src/a.ts', index: 'M', working_dir: ' ' }],
        current: 'main',
        ahead: 0,
        behind: 0,
        tracking: 'origin/main',
      } as any);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: 'test', verificationOutcomes: [] });

      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.hasChanges).toBe(true);
      }
    });

    it('runBackend returns hasChanges: false when git status reports empty', async () => {
      gitService.getStatus.mockResolvedValue({
        isClean: () => true,
        modified: [],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        created: [],
        files: [],
        current: 'main',
        ahead: 0,
        behind: 0,
        tracking: 'origin/main',
      } as any);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: 'test', verificationOutcomes: [] });

      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.hasChanges).toBe(false);
      }
    });
  });

  describe('commit policy enforcement', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('includes both repo conventions and commit-policy text in conventionsSection', async () => {
      jest.spyOn(detectRepoConventionsModule, 'formatRepoConventionsPromptSection')
        .mockReturnValue('Repository conventions (repo-a):\n- Language: typescript');
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const call = adapterSpy.mock.calls[0][0];
      expect(call.conventionsSection).toContain('Repository conventions (repo-a):');
      expect(call.conventionsSection).toContain('Commit policy:');
    });

    it('still injects the commit-policy text when repo conventions formatting is empty', async () => {
      jest.spyOn(detectRepoConventionsModule, 'formatRepoConventionsPromptSection').mockReturnValue('');
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const call = adapterSpy.mock.calls[0][0];
      expect(call.conventionsSection).toContain('Commit policy:');
    });

    it('rewinds commits via resetSoftToCommit when medium complexity and HEAD moved', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'agent commit' }]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.resetSoftToCommit).toHaveBeenCalledWith('baseline-sha', '/tmp/repo-a');
    });

    it('does not rewind when complexity is low even though HEAD moved', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockResolvedValue([{ hash: 'new-sha', subject: 'Feat: Add thing' }]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
    });

    it('does not rewind when HEAD is unchanged', async () => {
      gitService.getRecentCommits.mockResolvedValue([
        { hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') },
      ]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
    });

    it('does not rewind and does not crash when baseline lookup throws', async () => {
      gitService.getRecentCommits.mockRejectedValueOnce(new Error('no commits yet'));
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      })).resolves.toBeDefined();

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
    });

    it('does not rewind and warns when the branch changed during implementation', async () => {
      let branchCallCount = 0;
      gitService.getCurrentBranch.mockImplementation(async () => {
        branchCallCount += 1;
        // First call is the pre-run branch snapshot taken by the branch
        // workflow itself, and the second is the commit-policy baseline —
        // both happen before the agent runs, so both report 'main'. Any
        // call after that is the post-run enforcement check, which should
        // observe the branch switch.
        return branchCallCount <= 2 ? 'main' : 'some-other-branch';
      });
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('branch changed'))).toBe(true);
    });

    it('does not rewind and warns when merge commits are present in the range', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockResolvedValueOnce([{ hash: 'merge-sha', subject: 'Merge branch x' }]);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('merge commits'))).toBe(true);
    });

    it('does not rewind and warns when commits are already pushed upstream', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.hasUpstream.mockResolvedValue(true);
      gitService.listCommitsInRange.mockImplementation(async (opts: { from: string; mergesOnly?: boolean }) => {
        if (opts.mergesOnly) return [];
        if (opts.from === 'baseline-sha') return [{ hash: 'new-sha', subject: 'agent commit' }];
        return [];
      });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('already pushed'))).toBe(true);
    });

    it('reports hasChanges: true after a rewind, so review is not skipped', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'agent commit' }]);
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: [],
        staged: ['src/a.ts'],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [{ path: 'src/a.ts', index: 'M', working_dir: ' ' }],
      } as any);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      const result = await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.resetSoftToCommit).toHaveBeenCalledWith('baseline-sha', '/tmp/repo-a');
      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.hasChanges).toBe(true);
      }
    });

    it('runs enforceCommitPolicy and then re-throws when the adapter throws', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'agent commit' }]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockRejectedValue(new Error('API rate limit'));

      await expect(agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      })).rejects.toThrow('API rate limit');

      expect(gitService.resetSoftToCommit).toHaveBeenCalledWith('baseline-sha', '/tmp/repo-a');
    });

    it('does not crash and skips rewind when a git safety check throws during enforcement', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'baseline-sha', message: 'baseline', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'agent commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockRejectedValue(new Error('fatal: shallow repository'));
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'medium',
      }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      })).resolves.toBeDefined();

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('git safety check failed'))).toBe(true);
    });
  });

  describe('enforceCommitSubjectRule (low-complexity backstop)', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('rewinds when a low-complexity commit has a lowercase subject', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'base-sha', message: 'base', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'raw commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'feat: add thing' }]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low',
      }), { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true });

      expect(gitService.resetSoftToCommit).toHaveBeenCalledWith('base-sha', '/tmp/repo-a');
    });

    it('does not rewind when a low-complexity commit has an uppercase subject', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'base-sha', message: 'base', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'raw commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'feat: Add thing' }]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low',
      }), { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
    });

    it('skips rewind when branch changed, even for a lowercase low-complexity subject', async () => {
      let branchCallCount = 0;
      gitService.getCurrentBranch.mockImplementation(async () => {
        branchCallCount += 1;
        return branchCallCount <= 2 ? 'main' : 'some-other-branch';
      });
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'base-sha', message: 'base', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'raw commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockImplementation(async (opts: { mergesOnly?: boolean }) =>
        opts.mergesOnly ? [] : [{ hash: 'new-sha', subject: 'feat: add thing' }]);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low',
      }), { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, noBranch: true });

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('branch changed'))).toBe(true);
    });

    it('does not crash when listCommitsInRange throws during the subject rule check', async () => {
      gitService.getRecentCommits
        .mockResolvedValueOnce([{ hash: 'base-sha', message: 'base', author: 'a', date: new Date('2024-01-01') }])
        .mockResolvedValueOnce([{ hash: 'new-sha', message: 'raw commit', author: 'a', date: new Date('2024-01-02') }]);
      gitService.listCommitsInRange.mockRejectedValue(new Error('git error'));
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });

      await expect(agent.execute(ticketArtifact, buildPlan({
        affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low',
      }), { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true })).resolves.toBeDefined();

      expect(gitService.resetSoftToCommit).not.toHaveBeenCalled();
    });
  });

  describe('branch workflow', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.clearAllMocks();
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
        files: [],
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
        files: [],
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
        files: [],
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

    it('continues without stashing when user selects continue in interactive mode', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      gitService.getStatus.mockResolvedValueOnce({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [],
      } as any);

      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt
        .mockResolvedValueOnce({ branchAction: 'create' } as any)
        .mockResolvedValueOnce({ dirtyTreeAction: 'continue' } as any)
        .mockResolvedValueOnce({ choice: 'accept' } as any);

      gitService.detectDevelopmentBranches.mockReturnValue(['develop']);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: false,
      });

      expect(gitService.stashChanges).not.toHaveBeenCalled();
      expect(gitService.stashPop).not.toHaveBeenCalled();
    });

    it('displays the resolved source branch via the CLI presenter', async () => {
      gitService.detectDevelopmentBranches.mockReturnValue(['develop']);
      gitService.hasUpstream.mockResolvedValue(true);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(presenter.detail).toHaveBeenCalledWith('Source branch', 'develop (has upstream)');
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

    it('prompts for source branch selection in silent mode when TTY is available', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      gitService.detectDevelopmentBranches.mockReturnValue(['develop', 'dev']);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt
        .mockResolvedValueOnce({ branchAction: 'create' } as any)
        .mockResolvedValueOnce({ selected: 'develop' } as any)
        .mockResolvedValueOnce({ choice: 'accept' } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(mockPrompt).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'selected' })]));
    });

    it('prompts for branch name in silent mode when TTY is available', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt
        .mockResolvedValueOnce({ branchAction: 'create' } as any)
        .mockResolvedValueOnce({ choice: 'accept' } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(mockPrompt).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'choice' })]));
      expect(gitService.createBranch).toHaveBeenCalled();
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
      expect(gitService.createBranch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ baseBranch: 'remotes/origin/develop', cwd: '/tmp/repo-a' })
      );
    });

    it('does not create branch when --no-branch is set', async () => {
      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.getBranchInfo).not.toHaveBeenCalled();
      expect(gitService.checkoutBranch).not.toHaveBeenCalled();
      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(gitService.pull).toHaveBeenCalledWith('origin', 'main', '/tmp/repo-a');
      expect(result).toEqual({
        type: 'implementation', hasChanges: false, branchName: 'main', sessionId: undefined, verificationOutcomes: [],
      });
    });

    it('stays on current branch when user selects stay interactively', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt
        .mockResolvedValueOnce({ branchAction: 'stay' } as any)
        .mockResolvedValueOnce({ shouldPull: false } as any);

      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      expect(result).toEqual({
        type: 'implementation', hasChanges: false, branchName: 'main', sessionId: undefined, verificationOutcomes: [],
      });
      expect(gitService.getBranchInfo).not.toHaveBeenCalled();
      expect(gitService.checkoutBranch).not.toHaveBeenCalled();
      expect(gitService.createBranch).not.toHaveBeenCalled();
    });

    it('offers pull on current branch when --no-branch is set', async () => {
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.getBranchInfo).not.toHaveBeenCalled();
      expect(gitService.pull).toHaveBeenCalledWith('origin', 'main', '/tmp/repo-a');
    });

    it('skips pull when user declines in --no-branch interactive mode', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt.mockResolvedValueOnce({ shouldPull: false } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.pull).not.toHaveBeenCalled();
      expect(gitService.stashChanges).not.toHaveBeenCalled();
    });

    it('warns and continues when current-branch pull fails in --no-branch mode', async () => {
      gitService.pull.mockRejectedValue(new Error('no upstream'));

      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.getBranchInfo).not.toHaveBeenCalled();
      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(gitService.pull).toHaveBeenCalledWith('origin', 'main', '/tmp/repo-a');
      expect(result).toEqual({
        type: 'implementation', hasChanges: false, branchName: 'main', sessionId: undefined, verificationOutcomes: [],
      });
    });

    it('skips stash when user declines pull in stay path', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [],
      } as any);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt.mockResolvedValueOnce({ shouldPull: false } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.stashChanges).not.toHaveBeenCalled();
      expect(gitService.pull).not.toHaveBeenCalled();
    });

    it('stashes before pull and restores after in stay path', async () => {
      jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [],
      } as any);
      const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      mockPrompt.mockResolvedValueOnce({ shouldPull: true } as any);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        noBranch: true,
      });

      expect(gitService.stashChanges).toHaveBeenCalled();
      expect(gitService.pull).toHaveBeenCalledWith('origin', 'main', '/tmp/repo-a');
      expect(gitService.stashPop).toHaveBeenCalled();
      expect(gitService.stashChanges.mock.invocationCallOrder[0]).toBeLessThan(
        gitService.pull.mock.invocationCallOrder[0]
      );
      expect(gitService.pull.mock.invocationCallOrder[0]).toBeLessThan(gitService.stashPop.mock.invocationCallOrder[0]);
    });

    describe('custom branch name entry', () => {
      const pastedCommand = 'git checkout -b fix/WBP-4015__reviews-feed-tour-name-tag-missing-on-some-review-cards';

      it('sanitizes a pasted git checkout command into the bare branch name', async () => {
        const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
        mockPrompt
          .mockResolvedValueOnce({ choice: 'edit' } as any)
          .mockResolvedValueOnce({ customName: `  ${pastedCommand} ` } as any);

        const branchName = await (agent as any).promptBranchName({
          generatedName: 'fix/WBP-4015__generated',
          interactive: true,
        });

        expect(branchName).toBe('fix/WBP-4015__reviews-feed-tour-name-tag-missing-on-some-review-cards');
      });

      it('re-prompts after an invalid branch name error, logging the failure', async () => {
        jest.spyOn(agent as any, 'isInteractiveSession').mockReturnValue(true);
        const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
        mockPrompt
          .mockResolvedValueOnce({ branchAction: 'create' } as any)
          .mockResolvedValueOnce({ choice: 'accept' } as any)
          .mockResolvedValueOnce({ customName: 'fix/WBP-4015__corrected' } as any);
        gitService.createBranch
          .mockRejectedValueOnce(new InvalidBranchNameError('Invalid branch name: bad. Branch names cannot contain spaces'))
          .mockResolvedValueOnce(undefined);

        await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
          silent: false,
        });

        expect(gitService.createBranch).toHaveBeenCalledTimes(2);
        expect(gitService.createBranch).toHaveBeenLastCalledWith(
          'fix/WBP-4015__corrected',
          expect.objectContaining({ baseBranch: 'develop', cwd: '/tmp/repo-a' })
        );
        expect(appendToLogFile).toHaveBeenCalledWith(
          'ERROR',
          expect.stringContaining('Invalid branch name: bad'),
          'implement'
        );
      });

      it('propagates an invalid branch name error without prompting in non-interactive mode', async () => {
        gitService.createBranch.mockRejectedValueOnce(
          new InvalidBranchNameError('Invalid branch name: bad. Branch names cannot contain spaces')
        );

        await expect(
          agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
            trackerName: 'jira',
            repoDir: '/tmp/repo-a',
            silent: true,
          })
        ).rejects.toThrow('Invalid branch name: bad');

        expect(gitService.createBranch).toHaveBeenCalledTimes(1);
        expect(inquirer.prompt).not.toHaveBeenCalled();
      });

      it('validates edited branch names against the resolved branch name pattern', async () => {
        const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
        mockPrompt
          .mockResolvedValueOnce({ choice: 'edit' } as any)
          .mockResolvedValueOnce({ customName: 'team/checkout-totals' } as any);

        await (agent as any).promptBranchName({
          generatedName: 'team/checkout-totals',
          interactive: true,
          pattern: '^team\\/[a-z-]+$',
        });

        const [inputQuestion] = mockPrompt.mock.calls[1][0] as any[];
        expect(inputQuestion.validate('team/checkout-totals')).toBe(true);
        expect(inputQuestion.validate('fix/checkout-totals')).toBe(
          'Branch names should follow pattern: ^team\\/[a-z-]+$'
        );
      });

      it('resolves the prompt pattern from config when no flag override is given', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) =>
          key === 'git.branchNamePattern' ? '^team\\/[a-z-]+$' : fallback
        );

        expect((agent as any).resolveBranchNamePattern(undefined)).toBe('^team\\/[a-z-]+$');
        expect((agent as any).resolveBranchNamePattern('^[a-z]+\\/[\\w-]+$')).toBe('^[a-z]+\\/[\\w-]+$');
      });

      it('threads the --branch-name-pattern override through to branch creation', async () => {
        await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
          silent: true,
          branchNamePattern: '^[a-z]+\\/[\\w-]+$',
        });

        expect(gitService.createBranch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ patternOverride: '^[a-z]+\\/[\\w-]+$' })
        );
      });

      it('validates edited branch names at the prompt instead of failing after submission', async () => {
        const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
        mockPrompt
          .mockResolvedValueOnce({ choice: 'edit' } as any)
          .mockResolvedValueOnce({ customName: 'fix/WBP-4015__generated' } as any);

        await (agent as any).promptBranchName({ generatedName: 'fix/WBP-4015__generated', interactive: true });

        const [inputQuestion] = mockPrompt.mock.calls[1][0] as any[];
        expect(inputQuestion.validate(pastedCommand)).toBe(true);
        expect(inputQuestion.validate('fix/name with spaces')).toBe('Branch names cannot contain spaces');
        expect(inputQuestion.validate('   ')).toBe('Branch name cannot be empty');
      });
    });

    it('truncates branch name at word boundary when exceeding max length', async () => {
      // 9 words × 10 chars + 8 hyphens = 98-char slug; prefix 'feature/WBP-1000__' = 18 chars; total 116 > 100
      const longSummary = Array.from({ length: 9 }, (_, i) => String.fromCharCode(65 + i).repeat(10)).join(' ');
      const longTicket = { ...ticketArtifact, content: `# WBP-1000: ${longSummary}` };
      const consoleSpy = jest.spyOn(console, 'log');

      await agent.execute(longTicket, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const [branchName] = gitService.createBranch.mock.calls[0];
      expect(branchName.length).toBeLessThanOrEqual(100);
      expect(branchName).not.toMatch(/-$/);
      expect(
        consoleSpy.mock.calls.some(args => typeof args[0] === 'string' && args[0].includes('truncated to fit'))
      ).toBe(true);
    });

    it('does not truncate branch name within limit', async () => {
      const consoleSpy = jest.spyOn(console, 'log');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const truncatedLog = consoleSpy.mock.calls.find(
        args => typeof args[0] === 'string' && args[0].includes('truncated to fit')
      );
      expect(truncatedLog).toBeUndefined();
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
        files: [],
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
        files: [],
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

    it('skips branch workflow when isNewRepo is true', async () => {
      const result = await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
        isNewRepo: true,
      });

      expect(gitService.getBranchInfo).not.toHaveBeenCalled();
      expect(gitService.checkoutBranch).not.toHaveBeenCalled();
      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(gitService.pull).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'implementation', hasChanges: false, branchName: 'main', sessionId: undefined, verificationOutcomes: [],
      });
    });

    it('logs skip message when isNewRepo is true and not silent', async () => {
      const consoleSpy = jest.spyOn(console, 'log');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: false,
        isNewRepo: true,
      });

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(msg => msg.includes('Branch workflow: Skip (newly scaffolded)'))).toBe(true);
    });

    it('throws GitError when source branch checkout fails due to dirty working tree', async () => {
      gitService.detectDevelopmentBranches.mockReturnValue(['develop']);
      gitService.checkoutBranch.mockRejectedValue(new Error('checkout conflict'));

      await expect(
        agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira',
          repoDir: '/tmp/repo-a',
          silent: true,
        })
      ).rejects.toThrow(/Cannot switch to source branch/);

      expect(gitService.createBranch).not.toHaveBeenCalled();
    });

    it('passes skipInstall: true to runPostPullDependencyInstall when option is set', async () => {
      const { runPostPullDependencyInstall } = jest.requireMock('../shared/utils/post-pull-install');
      (runPostPullDependencyInstall as jest.Mock).mockClear();
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', skipInstall: true, silent: true,
      });
      expect(runPostPullDependencyInstall).toHaveBeenCalledWith(expect.any(String), true);
    });

    it('passes skipInstall: undefined to runPostPullDependencyInstall by default', async () => {
      const { runPostPullDependencyInstall } = jest.requireMock('../shared/utils/post-pull-install');
      (runPostPullDependencyInstall as jest.Mock).mockClear();
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
      });
      expect(runPostPullDependencyInstall).toHaveBeenCalledWith(expect.any(String), undefined);
    });
  });

  describe('tracked file validation', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
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
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
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

      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
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

  describe('skill integration', () => {
    let savedSkills: Map<string, import('../skills/skill.types').SkillDefinition>;

    beforeEach(() => {
      savedSkills = new Map(KNOWN_SKILLS);
      KNOWN_SKILLS.clear();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      KNOWN_SKILLS.clear();
      for (const [k, v] of savedSkills) KNOWN_SKILLS.set(k, v);
    });

    it('passes resolved skillNames to the adapter when implement skills are configured', async () => {
      registerSkill({ id: 'test-driven-development', stages: ['plan', 'implement'] });
      const configGet = configService.get as jest.Mock;
      configGet.mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.skills') return ['test-driven-development'];
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
      });

      expect(adapterSpy.mock.calls[0][0].skillNames).toEqual(['test-driven-development']);
    });

    it('throws ConfigurationError when skill does not support the implement stage', async () => {
      registerSkill({ id: 'writing-plans', stages: ['plan'] });
      const configGet = configService.get as jest.Mock;
      configGet.mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.skills') return ['writing-plans'];
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });

      await expect(
        agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
          trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
        })
      ).rejects.toThrow('does not support the "implement" stage');
    });

    it('passes undefined skillNames when no skills are configured', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
      });

      expect(adapterSpy.mock.calls[0][0].skillNames).toBeUndefined();
    });
  });

  describe('Figma context injection', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('passes configKey stages.implement.figma so the service reads the correct config path', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      const figmaStageService = (agent as any).figmaStageService as { resolveIfEnabled: jest.Mock };
      figmaStageService.resolveIfEnabled.mockResolvedValue(undefined);

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, figma: false,
      });

      expect(figmaStageService.resolveIfEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ configKey: 'stages.implement.figma', artifactPath: '/tmp/.wf/repo-a/jira/WBP-1000-plan-feature.json' })
      );
    });

    it('forwards figmaContextSection (not figmaSkillHint) to the adapter when frames are returned', async () => {
      const mockFrames = [{ url: 'https://figma.com/design/A/F?node-id=1-1', name: 'HeroCard', width: 1440, height: 900, screenshotUrl: 'https://s3/img.png', layout: { name: 'HeroCard', width: 1440, height: 900 } }];
      const figmaStageService = (agent as any).figmaStageService as { resolveIfEnabled: jest.Mock };
      figmaStageService.resolveIfEnabled.mockResolvedValue({ figmaLinks: ['https://figma.com/design/A/F?node-id=1-1'], frames: mockFrames });
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, figma: true,
      });

      const callArg = adapterSpy.mock.calls[0][0];
      expect(callArg).toHaveProperty('figmaContextSection');
      expect(callArg.figmaContextSection).toContain('HeroCard');
    });
  });

  describe('verification manifest resolution', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('returns undefined when configured policyFile does not exist on disk', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
        const s = String(p);
        if (s.includes('verification') || s.includes('policy')) return false;
        return s.startsWith('/tmp/repo-a/src/') || s.endsWith('/package.json');
      });

      const configGet = configService.get as jest.Mock;
      configGet.mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.verificationConditions') return {
          policyFile: 'verification.policy.json',
          scripts: { build: 'yarn build' },
        };
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }), {
        trackerName: 'jira',
        repoDir: '/tmp/repo-a',
        silent: true,
      });

      const call = adapterSpy.mock.calls[0][0];
      const scripts = call.verificationScripts as Array<{ id: string; command: string }>;
      expect(scripts.some(s => s.command === 'yarn build')).toBe(true);
    });
  });

  describe('verification step repo scoping', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: undefined,
        verificationOutcomes: [],
      });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    it('passes only repo-a targeted steps to adapter in a multi-repo plan', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
        const s = String(p);
        return s.startsWith('/tmp/repo-a/src/') || s.endsWith('/package.json');
      });

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a', 'shop-v1.1'],
          verification: {
            targeted: [
              { id: 'typecheck-shop', run: 'yarn typecheck', policy: 'enforced', repo: 'shop-v1.1' },
              {
                id: 'test-repo-a', run: 'yarn test -- src/example.spec.ts', policy: 'enforced',
                repo: 'repo-a', earlyExitPattern: 'Tests passed',
              },
            ],
          },
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, allowMultiRepoScope: true },
      );

      const scripts = adapterSpy.mock.calls[0][0].verificationScripts as Array<{
        id: string;
        earlyExitPattern?: string;
      }>;
      const ids = scripts.map(s => s.id);
      expect(ids).toContain('test-repo-a');
      expect(ids).not.toContain('typecheck-shop');
      expect(scripts.find(s => s.id === 'test-repo-a')?.earlyExitPattern).toBe('Tests passed');
    });

    it('passes all targeted steps through in a single-repo plan', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
        const s = String(p);
        return s.startsWith('/tmp/repo-a/src/') || s.endsWith('/package.json');
      });

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a'],
          verification: {
            targeted: [
              { id: 'typecheck-repo-a', run: 'yarn typecheck', policy: 'enforced', repo: 'repo-a' },
            ],
          },
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const scripts = adapterSpy.mock.calls[0][0].verificationScripts as Array<{ id: string }>;
      expect(scripts.some(s => s.id === 'typecheck-repo-a')).toBe(true);
    });

    it('logs a warning when steps are dropped due to repo mismatch', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
        const s = String(p);
        return s.startsWith('/tmp/repo-a/src/') || s.endsWith('/package.json');
      });

      const consoleSpy = jest.spyOn(console, 'log');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a', 'shop-v1.1'],
          verification: {
            targeted: [
              { id: 'typecheck-shop', run: 'yarn typecheck', policy: 'enforced', repo: 'shop-v1.1' },
            ],
          },
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, allowMultiRepoScope: true },
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('typecheck-shop'),
      );
    });
  });

  describe('plan step filtering', () => {
    beforeEach(() => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('includes steps referencing the current repo files and excludes steps for other repos', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: [
            'Update repo-a/src/services/booking.mapper.ts to fix the issue',
            'Update cop-nuxt-app/src/services/booking.service.ts for the API change',
            'Run verification tests',
          ],
          affectedFiles: ['repo-a/src/services/booking.mapper.ts'],
          affectedRepositories: ['repo-a'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toHaveLength(2);
      expect(passedPlan.steps).toContain('Update repo-a/src/services/booking.mapper.ts to fix the issue');
      expect(passedPlan.steps).toContain('Run verification tests');
      expect(passedPlan.steps).not.toContain('Update cop-nuxt-app/src/services/booking.service.ts for the API change');
    });

    it('passes all steps through when repoName is empty (no repoDir)', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: ['Step A', 'Step B'],
          affectedFiles: ['src/example.ts'],
          affectedRepositories: [],
        }),
        { trackerName: 'jira', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toEqual(['Step A', 'Step B']);
    });

    it('passes all steps through when repoFiles is empty', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: ['Step A', 'Step B'],
          affectedFiles: [],
          affectedRepositories: ['repo-a'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toEqual(['Step A', 'Step B']);
    });

    it('always includes generic steps with no repo-prefixed path', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: ['Run yarn test', 'Check CI status', 'Update src/example.ts in repo-a'],
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toContain('Run yarn test');
      expect(passedPlan.steps).toContain('Check CI status');
      expect(passedPlan.steps).toContain('Update src/example.ts in repo-a');
    });

    it('does not exclude a step using the "<repo> — src/..." planner format', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: ['api-gateway-v1 — in src/reviews/reviews.controller.ts add endpoint'],
          affectedFiles: ['api-gateway-v1/src/reviews/reviews.controller.ts'],
          affectedRepositories: ['api-gateway-v1'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/api-gateway-v1', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toContain(
        'api-gateway-v1 — in src/reviews/reviews.controller.ts add endpoint',
      );
    });

    it('does not treat a step with an incidental src-like word without a trailing slash as a repo path', async () => {
      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await agent.execute(
        ticketArtifact,
        buildPlan({
          steps: ['update docs/src-notes.md with changelog'],
          affectedFiles: [],
          affectedRepositories: ['repo-a'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const passedPlan = adapterSpy.mock.calls[0][0].planArtifact.plan;
      expect(passedPlan.steps).toContain('update docs/src-notes.md with changelog');
    });
  });

  describe('verification skip for new repos', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes empty verificationScripts to adapter when isNewRepo is true', async () => {
      const adapterSpy = jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, isNewRepo: true },
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.verificationScripts).toEqual([]);
    });

    it('passes non-empty verificationScripts when isNewRepo is false', async () => {
      const adapterSpy = jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, isNewRepo: false },
      );

      const call = adapterSpy.mock.calls[0][0];
      expect(call.verificationScripts.length).toBeGreaterThan(0);
    });

    it('passes repo conventions to the adapter prompt context', async () => {
      const adapterSpy = jest
        .spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify')
        .mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => {
        const value = String(p);
        return (
          value.startsWith('/tmp/repo-a/src/')
          || value.endsWith('/package.json')
          || value.endsWith('/.eslintrc.json')
        );
      });
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((filePath: string) => {
        const value = String(filePath);
        if (value.endsWith('.eslintrc.json')) {
          return JSON.stringify({ rules: { semi: ['error', 'always'] } });
        }
        if (value.includes('package.json')) {
          return JSON.stringify({ dependencies: { '@nestjs/core': '^11.0.0' } });
        }
        throw new Error(`Unexpected read: ${filePath}`);
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(adapterSpy.mock.calls[0][0].conventionsSection).toContain('Repository conventions (repo-a):');
    });
  });

  describe('investigation CLI routing', () => {
    const buildInvestigationModule = async (backend: string) => {
      const mockStageAgentService = {
        isEnabledForStage: jest.fn().mockReturnValue(true),
        chatTurn: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            action: 'investigate',
            summary: 'found root cause',
            findings: [],
            recommendations: [],
            conclusion: 'fixed',
          }),
          session: {},
        }),
        logResolvedStageTarget: jest.fn(),
      };

      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
                if (key === 'stages.implement.backend') return backend;
                return fallback;
              }),
            },
          },
          {
            provide: GitService,
            useValue: { getCurrentBranch: jest.fn() },
          },
          {
            provide: AiService,
            useValue: {
              generateFindings: jest.fn().mockResolvedValue({
                action: 'investigate', summary: 's', findings: [], recommendations: [], conclusion: 'c',
              }),
            },
          },
          {
            provide: StageAgentService,
            useValue: mockStageAgentService,
          },
          {
            provide: PlanStepVerificationService,
            useValue: {
              run: jest.fn().mockResolvedValue({ sessionId: undefined, summary: undefined, extraPassCount: 0 }),
            },
          },
          {
            provide: StepSpecFidelityService,
            useValue: {
              run: jest.fn().mockResolvedValue([]),
              verifyAll: jest.fn().mockResolvedValue({ findingsPerStep: new Map([[0, []]]), failures: [] }),
            },
          },
          { provide: FigmaStageService, useValue: { resolveIfEnabled: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      return {
        agent: module.get(ImplementerAgent),
        aiService: module.get(AiService),
        stageAgentService: mockStageAgentService,
      };
    };

    it('routes executeInvestigation through stageAgentService.chatTurn when implement backend is cli', async () => {
      const { agent: investigationAgent, aiService: investigationAiService, stageAgentService } = await buildInvestigationModule('cli');

      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);

      await (investigationAgent as any).executeInvestigation(
        ticketArtifact,
        {
          action: 'investigate',
          path: '/tmp/.wf/repo-a/jira/WBP-1000-plan-investigate.json',
          plan: { action: 'investigate', summary: 'check auth', steps: ['check'], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
        }
      );

      expect(stageAgentService.chatTurn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'implement' }));
      expect(investigationAiService.generateFindings).not.toHaveBeenCalled();
    });

    it('uses aiService.generateFindings when implement backend is standard', async () => {
      const { agent: investigationAgent, aiService: investigationAiService, stageAgentService } = await buildInvestigationModule('standard');

      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);

      await (investigationAgent as any).executeInvestigation(
        ticketArtifact,
        {
          action: 'investigate',
          path: '/tmp/.wf/repo-a/jira/WBP-1000-plan-investigate.json',
          plan: { action: 'investigate', summary: 'check auth', steps: ['check'], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
        }
      );

      expect(investigationAiService.generateFindings).toHaveBeenCalled();
      expect(stageAgentService.chatTurn).not.toHaveBeenCalled();
    });
  });

  describe('plan step verification seam', () => {
    const setupWithChanges = () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) =>
        String(p).endsWith('/package.json') || String(p).startsWith('/tmp/repo-a/src/')
      );
      (gitService.getStatus as jest.Mock).mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [{ path: 'src/example.ts' }],
      });
    };

    afterEach(() => jest.restoreAllMocks());

    it('calls service.run when all conditions are met', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).toHaveBeenCalled();
    });

    it('threads configured mode and assessor target to verification', async () => {
      setupWithChanges();
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.planStepVerification') {
          return { mode: 'pull', provider: 'openai', model: 'gpt-5.6-terra' };
        }
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'pull', assessorProvider: 'openai', assessorModel: 'gpt-5.6-terra',
      }));
    });

    it('uses the implement provider for a model-only assessor override', async () => {
      setupWithChanges();
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.planStepVerification') return { model: 'claude-sonnet-4-6' };
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: 'sess-1', verificationOutcomes: [] });
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
      });
      expect(planStepVerificationService.run).toHaveBeenCalledWith(expect.objectContaining({
        assessorProvider: 'anthropic', assessorModel: 'claude-sonnet-4-6',
      }));
    });

    it('omits unconfigured mode and assessor target keys', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: 'sess-1', verificationOutcomes: [] });
      await agent.execute(ticketArtifact, buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }), {
        trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true,
      });
      const params = planStepVerificationService.run.mock.calls[0][0];
      expect(params).not.toHaveProperty('mode');
      expect(params).not.toHaveProperty('assessorProvider');
      expect(params).not.toHaveProperty('assessorModel');
    });

    it('skips service.run when cfg.enabled is false', async () => {
      setupWithChanges();
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.planStepVerification') return { enabled: false };
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).not.toHaveBeenCalled();
    });

    it('skips service.run when isNewRepo is true', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, isNewRepo: true },
      );

      expect(planStepVerificationService.run).not.toHaveBeenCalled();
    });

    it('skips service.run when commit policy allows commits (low estimated complexity)', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low' }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).not.toHaveBeenCalled();
    });

    it('attaches stepVerification to result when summary is present', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });
      planStepVerificationService.run.mockResolvedValue({
        sessionId: 'sess-2',
        summary: { rounds: 1, done: 1, pending: 0 },
        extraPassCount: 0,
      });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.stepVerification).toEqual({ rounds: 1, done: 1, pending: 0 });
      }
    });

    it('accumulates extraPassCount from service into passCount', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });
      planStepVerificationService.run.mockResolvedValue({
        sessionId: 'sess-2',
        summary: { rounds: 1, done: 1, pending: 0 },
        extraPassCount: 3,
      });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.passCount).toBe(3);
      }
    });

    it('refreshes sessionId from service outcome', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });
      planStepVerificationService.run.mockResolvedValue({
        sessionId: 'sess-updated',
        summary: undefined,
        extraPassCount: 0,
      });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
      if (result.type === 'implementation') {
        expect(result.sessionId).toBe('sess-updated');
      }
    });

    it('skips service.run in multi-repo mode when all steps are generic (no repo-prefixed path)', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          steps: ['Run the tests', 'Confirm existing behaviour'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, additionalRepoDirs: ['/tmp/repo-b'] },
      );

      expect(planStepVerificationService.run).not.toHaveBeenCalled();
    });

    it('passes only repo-prefixed steps to service.run in multi-repo mode', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          steps: ['Run the tests', 'repo-a/src/example.ts: update handler'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, additionalRepoDirs: ['/tmp/repo-b'] },
      );

      expect(planStepVerificationService.run).toHaveBeenCalledWith(
        expect.objectContaining({ steps: ['repo-a/src/example.ts: update handler'] }),
      );
    });

    it('does not zero out assessedSteps when steps use the "<repo> — src/..." planner format', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          steps: ['api-gateway-v1 — in src/example.ts add endpoint'],
          estimatedComplexity: 'high',
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, additionalRepoDirs: ['/tmp/repo-b'] },
      );

      expect(planStepVerificationService.run).toHaveBeenCalled();
    });

    it('logs skip reason "disabled" when cfg.enabled is false', async () => {
      setupWithChanges();
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.planStepVerification') return { enabled: false };
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.logSkip).toHaveBeenCalledWith('disabled', true);
    });

    it('logs skip reason "no-changes" when result has no changes', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      (gitService.getStatus as jest.Mock).mockResolvedValue({
        isClean: () => true,
        modified: [],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [],
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.logSkip).toHaveBeenCalledWith('no-changes', true);
    });

    it('logs skip reason "no-assessed-steps" when all steps are generic in multi-repo mode', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({
          affectedFiles: ['repo-a/src/example.ts'],
          steps: ['Run the tests', 'Update CHANGELOG'],
        }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, additionalRepoDirs: ['/tmp/repo-b'] },
      );

      expect(planStepVerificationService.logSkip).toHaveBeenCalledWith('no-assessed-steps', true);
    });

    it('logs skip reason "new-repo" when isNewRepo is true', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true, isNewRepo: true },
      );

      expect(planStepVerificationService.logSkip).toHaveBeenCalledWith('new-repo', true);
    });

    it('logs skip reason "commit-policy-allows-direct-commit" for low estimated complexity', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], estimatedComplexity: 'low' }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.logSkip).toHaveBeenCalledWith(
        'commit-policy-allows-direct-commit',
        true,
      );
    });

    it('returns the original result when service.run throws unexpectedly', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });
      planStepVerificationService.run.mockRejectedValue(new Error('network failure'));

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['repo-a/src/example.ts: update'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
      expect((result as any).stepVerification).toBeUndefined();
    });
  });

  describe('spec fidelity enrichment', () => {
    const setupWithChanges = () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) =>
        String(p).endsWith('/package.json') || String(p).startsWith('/tmp/repo-a/src/')
      );
      (gitService.getStatus as jest.Mock).mockResolvedValue({
        isClean: () => false,
        modified: ['src/example.ts'],
        staged: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        files: [{ path: 'src/example.ts' }],
      });
    };

    afterEach(() => jest.restoreAllMocks());

    it('calls verifyAll with assessedSteps when planStepVerification is active', async () => {
      setupWithChanges();
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(stepSpecFidelityService.verifyAll).toHaveBeenCalledWith(
        [{ index: 0, text: 'Update source file' }],
        expect.any(String),
        expect.any(String),
      );
    });

    it('does not call verifyAll when planStepVerification is skipped due to cfg.enabled false', async () => {
      setupWithChanges();
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stages.implement.planStepVerification') return { enabled: false };
        if (key === 'stages.implement.verificationConditions') return undefined;
        if (key === 'stages.implement.provider') return 'anthropic';
        if (key === 'git.branchPrefixMapping') return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
        return fallback;
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(stepSpecFidelityService.verifyAll).not.toHaveBeenCalled();
    });

    it('passes a refreshSteps callback to PlanStepVerificationService when fidelity is active', async () => {
      setupWithChanges();
      stepSpecFidelityService.verifyAll.mockResolvedValue({
        findingsPerStep: new Map([[0, [{ severity: 'error', claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' }]]]),
        failures: [],
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Add regex /\\.ts$/'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).toHaveBeenCalledWith(
        expect.objectContaining({ refreshSteps: expect.any(Function) }),
      );
    });

    it('does not throw and returns implementation result when verifyAll rejects', async () => {
      setupWithChanges();
      stepSpecFidelityService.verifyAll.mockRejectedValue(new Error('ai error'));
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['repo-a/src/example.ts: update'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
    });

    it('calls verifyAll with undefined baseRef when no baseline is available', async () => {
      setupWithChanges();
      (gitService.getRecentCommits as jest.Mock).mockResolvedValue([]);
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(stepSpecFidelityService.verifyAll).toHaveBeenCalledWith(
        [{ index: 0, text: 'Update source file' }],
        expect.any(String),
        undefined,
      );
    });

    it('refreshSteps callback always returns a string array, never null, across repeated calls', async () => {
      setupWithChanges();
      stepSpecFidelityService.verifyAll.mockResolvedValue({
        findingsPerStep: new Map([[0, [{ severity: 'error', claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' }]]]),
        failures: [],
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Add regex /\\.ts$/'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const { refreshSteps } = (planStepVerificationService.run).mock.calls[0][0];

      const result1 = await refreshSteps([0]);
      const result2 = await refreshSteps([0]);
      const result3 = await refreshSteps([0]);

      expect(result1).toBeInstanceOf(Map);
      expect(result2).toBeInstanceOf(Map);
      expect(result3).toBeInstanceOf(Map);
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result3).not.toBeNull();
    });

    it('does not suppress duplicate findings returned within one refresh', async () => {
      setupWithChanges();
      const finding = { severity: 'error' as const, claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' };
      stepSpecFidelityService.verifyAll.mockResolvedValue({
        findingsPerStep: new Map([[0, [finding, finding]]]), failures: [],
      });
      let refreshed: Map<number, string> | undefined;
      let getSuppressed: (() => number) | undefined;
      planStepVerificationService.run.mockImplementation(async (params: {
        refreshSteps: (indices: number[]) => Promise<Map<number, string>>;
        getSuppressed: () => number;
      }) => {
        refreshed = await params.refreshSteps([0]);
        getSuppressed = params.getSuppressed;
        return { sessionId: undefined, summary: undefined, extraPassCount: 0 };
      });
      const suppressedLogCount = (appendToLogFile as jest.Mock).mock.calls
        .filter(([, message]) => String(message).includes('step-fidelity.suppressed')).length;
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Add regex /\\.ts$/'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(refreshed?.get(0)).toContain('[SPEC FIDELITY ERRORS');
      expect(getSuppressed?.()).toBe(0);
      expect((appendToLogFile as jest.Mock).mock.calls
        .filter(([, message]) => String(message).includes('step-fidelity.suppressed'))).toHaveLength(suppressedLogCount);
    });

    it('returns original steps unchanged when verifyAll result contains failures', async () => {
      setupWithChanges();
      stepSpecFidelityService.verifyAll.mockResolvedValue({
        findingsPerStep: new Map([[0, []]]),
        failures: [{ category: 'provider', stepIndex: 0, cause: 'timeout' }],
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(planStepVerificationService.run).toHaveBeenCalledWith(
        expect.objectContaining({ steps: ['Update source file'] }),
      );
    });

    it('logs a step-fidelity.degraded event for each failure without throwing', async () => {
      setupWithChanges();
      stepSpecFidelityService.verifyAll.mockResolvedValue({
        findingsPerStep: new Map([[0, []]]),
        failures: [{ category: 'provider', stepIndex: 0, cause: 'timeout' }],
      });
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({
        sessionId: 'sess-1', verificationOutcomes: [],
      });

      const result = await agent.execute(
        ticketArtifact,
        buildPlan({ affectedFiles: ['repo-a/src/example.ts'], steps: ['Update source file'] }),
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      expect(result.type).toBe('implementation');
      expect(appendToLogFile).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('step-fidelity.degraded'),
        'step-verification',
      );
    });
  });

  describe('UI design screenshots integration', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes uiDesignScreenshotPaths to adapter when UiDesignScreenshotsStageService resolves paths', async () => {
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue({ sessionId: undefined, verificationOutcomes: [] });
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockUiService = { resolveIfEnabled: jest.fn().mockResolvedValue({ screenshots: [], paths: ['/tmp/design.png'] }) };
      const module = await Test.createTestingModule({
        providers: [
          ImplementerAgent,
          {
            provide: CliPresenter,
            useValue: {
              stageHeader: jest.fn(), separator: jest.fn(), progress: jest.fn(),
              outcome: jest.fn(), detail: jest.fn(), summaryBlock: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
                if (key === 'stages.implement.provider') return 'anthropic';
                if (key === 'stages.implement.verificationConditions') return undefined;
                if (key === 'git.branchPrefixMapping') {
                  return { feature: 'feature', fix: 'bugfix', investigate: 'chore' };
                }
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
                isClean: () => true, modified: [], staged: [], deleted: [],
                renamed: [], conflicted: [], not_added: [], files: [],
              }),
              getBranchInfo: jest.fn().mockResolvedValue({
                current: 'main', all: ['main'], development: 'develop',
                isClean: true, hasUncommittedChanges: false,
              }),
              detectDevelopmentBranches: jest.fn().mockReturnValue(['develop']),
              detectMainBranch: jest.fn().mockReturnValue('main'),
              hasUpstream: jest.fn().mockResolvedValue(true),
              checkoutBranch: jest.fn().mockResolvedValue(undefined),
              pull: jest.fn().mockResolvedValue(undefined),
              stashChanges: jest.fn().mockResolvedValue(undefined),
              stashPop: jest.fn().mockResolvedValue(undefined),
              checkIgnored: jest.fn().mockResolvedValue([]),
              getRecentCommits: jest.fn().mockResolvedValue([
                { hash: 'abc', message: 'commit', author: 'tester', date: new Date() },
              ]),
              resetSoftToCommit: jest.fn().mockResolvedValue(undefined),
              listCommitsInRange: jest.fn().mockResolvedValue([]),
            },
          },
          { provide: AiService, useValue: { generateFindings: jest.fn() } },
          {
            provide: StageAgentService,
            useValue: {
              isEnabledForStage: jest.fn().mockReturnValue(false),
              chatTurn: jest.fn(),
              logResolvedStageTarget: jest.fn(),
            },
          },
          {
            provide: PlanStepVerificationService,
            useValue: {
              run: jest.fn().mockResolvedValue({ sessionId: undefined, summary: undefined, extraPassCount: 0 }),
              logSkip: jest.fn(),
            },
          },
          {
            provide: StepSpecFidelityService,
            useValue: {
              run: jest.fn().mockResolvedValue([]),
              verifyAll: jest.fn().mockResolvedValue({ findingsPerStep: new Map([[0, []]]), failures: [] }),
            },
          },
          { provide: FigmaStageService, useValue: { resolveIfEnabled: jest.fn().mockResolvedValue(undefined) } },
          { provide: UiDesignScreenshotsStageService, useValue: mockUiService },
        ],
      }).compile();

      const testAgent = module.get(ImplementerAgent);
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined as any);
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((p: string) => String(p).startsWith('/tmp/repo-a/src/') || String(p).endsWith('/package.json'));
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((fp: string) => {
        if (String(fp).includes('package.json')) return JSON.stringify({ scripts: {} });
        throw new Error(`Unexpected read: ${fp}`);
      });
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);

      const adapterSpy = jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify');

      await testAgent.execute(
        { ticketKey: 'WBP-1000', content: '# T', path: '/tmp/.wf/repo-a/jira/WBP-1000.md' },
        { action: 'feature', path: '/tmp/.wf/repo-a/jira/WBP-1000-plan-feature.json', plan: { action: 'feature', summary: 'Test', steps: ['Update src'], estimatedComplexity: 'medium', affectedFiles: ['repo-a/src/example.ts'], affectedRepositories: ['repo-a'] } },
        { trackerName: 'jira', repoDir: '/tmp/repo-a', silent: true },
      );

      const callArg = adapterSpy.mock.calls[0][0];
      expect(callArg).toHaveProperty('uiDesignScreenshotPaths', ['/tmp/design.png']);
    });
  });

  describe('verification pass offset threading', () => {
    const singleRepoPlan = () => buildPlan({
      affectedFiles: ['repo-a/src/example.ts'],
      affectedRepositories: ['repo-a'],
    });
    const options = { trackerName: 'jira' as const, repoDir: '/tmp/repo-a' };
    const resolved = { repoName: 'repo-a', repoDir: '/tmp/repo-a', repoFiles: [], contextFiles: [] };

    const spyBackend = (result: object) =>
      jest.spyOn(AnthropicAgentAdapter.prototype, 'generateAndVerify').mockResolvedValue(result as never);

    const offsetOfCall = (spy: ReturnType<typeof spyBackend>, index: number) =>
      (spy.mock.calls[index][0] as { verificationPassOffset?: number }).verificationPassOffset;

    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('passes verificationPassOffset 0 on a fresh run', async () => {
      const spy = spyBackend({ sessionId: undefined, verificationOutcomes: [] });

      await agent.execute(ticketArtifact, singleRepoPlan(), options);

      expect(offsetOfCall(spy, 0)).toBe(0);
    });

    it('accumulates verificationPassCount into the offset for subsequent backend calls', async () => {
      const spy = spyBackend({ sessionId: undefined, verificationOutcomes: [], verificationPassCount: 2 });

      const plan = singleRepoPlan();
      await agent.execute(ticketArtifact, plan, options);
      await (agent as any).executeBackendAdapter(ticketArtifact, plan, options, resolved);

      expect(offsetOfCall(spy, 1)).toBe(2);
    });

    it('treats a missing verificationPassCount as zero', async () => {
      const spy = spyBackend({ sessionId: undefined, verificationOutcomes: [] });

      const plan = singleRepoPlan();
      await agent.execute(ticketArtifact, plan, options);
      await (agent as any).executeBackendAdapter(ticketArtifact, plan, options, resolved);

      expect(offsetOfCall(spy, 1)).toBe(0);
    });

    it('leaves the offset unchanged when the backend rejects', async () => {
      const spy = spyBackend({ sessionId: undefined, verificationOutcomes: [], verificationPassCount: 2 });

      const plan = singleRepoPlan();
      await agent.execute(ticketArtifact, plan, options);

      spy.mockRejectedValueOnce(new Error('backend crashed'));
      await expect(
        (agent as any).executeBackendAdapter(ticketArtifact, plan, options, resolved),
      ).rejects.toThrow('backend crashed');

      await (agent as any).executeBackendAdapter(ticketArtifact, plan, options, resolved);
      expect(offsetOfCall(spy, 2)).toBe(2);
    });

    it('resets the offset at the start of each execute run', async () => {
      const spy = spyBackend({ sessionId: undefined, verificationOutcomes: [], verificationPassCount: 3 });

      await agent.execute(ticketArtifact, singleRepoPlan(), options);
      await agent.execute(ticketArtifact, singleRepoPlan(), options);

      expect(offsetOfCall(spy, 1)).toBe(0);
    });
  });
});
