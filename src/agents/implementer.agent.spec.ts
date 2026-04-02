import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ImplementerAgent } from './implementer.agent';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import type { PlanArtifact, TicketArtifact } from './interfaces';

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
                  'stages.implement.afterImplement': {
                    maxAttempts: 2,
                    fingerprintLineCount: 5,
                    requireStateChangeForRetry: true,
                    retryOnSameFailure: false,
                    scripts: {
                      lint: 'npm run lint',
                      build: 'npm run build',
                    },
                  },
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
            generateFileChange: jest
              .fn()
              .mockResolvedValue('export const value = 1;\n'),
            generateFindings: jest.fn(),
          },
        },
      ],
    }).compile();

    agent = module.get(ImplementerAgent);
    gitService = module.get(GitService);
    aiService = module.get(AiService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
            platformName: 'jira',
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
            platformName: 'jira',
            repoDir: '/tmp/repo-a',
          },
        ),
      ).rejects.toThrow(
        'issue:implement can only modify and verify files for repo-a. Found paths for other repositories: repo-b/src/example.ts. Use wf issue or run wf issue:implement separately per repository.',
      );
    });
  });

  describe('verification loop', () => {
    const installMockRepoFiles = () => {
      const mockFiles = new Map<string, string>([
        [
          '/tmp/repo-a/package.json',
          JSON.stringify({
            scripts: {
              lint: 'eslint .',
              build: 'tsc -p .',
            },
          }),
        ],
        ['/tmp/repo-a/src/example.ts', 'export const value = 0;\n'],
      ]);

      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((filePath: string) => mockFiles.has(filePath));
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockImplementation((filePath: string) => {
          const content = mockFiles.get(filePath);
          if (content === undefined) {
            throw new Error(`Unexpected read: ${filePath}`);
          }
          return content;
        });
      jest
        .spyOn(require('fs'), 'mkdirSync')
        .mockImplementation(() => undefined as any);
      jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation((filePath: string, content: string) => {
          mockFiles.set(filePath, content);
        });

      return mockFiles;
    };

    it('runs configured afterImplement scripts in order after generating files', async () => {
      installMockRepoFiles();

      const runCommandSpy = jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

      await agent.execute(ticketArtifact, buildPlan(), {
        platformName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      expect(gitService.createBranch).toHaveBeenCalledWith(
        'feature/WBP-1000__fix-build-verification',
        undefined,
        '/tmp/repo-a',
      );
      expect(aiService.generateFileChange).toHaveBeenCalledTimes(1);
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        1,
        'npm run lint',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        2,
        'npm run build',
        '/tmp/repo-a',
      );
    });

    it('retries with the full configured script sequence after actionable failures', async () => {
      installMockRepoFiles();

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const fixed = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 1,
          stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

      await agent.execute(ticketArtifact, buildPlan({}), {
        platformName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      expect(aiService.generateFileChange).toHaveBeenCalledTimes(2);
      const secondCall = aiService.generateFileChange.mock.calls[1][0];
      expect(secondCall.conversationContext).toContain(
        'Verification failed on attempt 1',
      );
      expect(secondCall.conversationContext).toContain('error TS1005');
    });

    it('stops retrying when the AI does not produce a state change after a failure', async () => {
      installMockRepoFiles();

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const broken = true;\n');

      jest.spyOn(agent as any, 'runCommand').mockResolvedValueOnce({
        command: 'npm run lint',
        exitCode: 1,
        stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
        stderr: '',
      });

      await expect(
        agent.execute(ticketArtifact, buildPlan({}), {
          platformName: 'jira',
          repoDir: '/tmp/repo-a',
        }),
      ).rejects.toThrow(/did not produce a state change/i);
    });

    it('treats formatter or linter rewrites as real state changes for the next retry', async () => {
      const mockFiles = installMockRepoFiles();

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const formatted = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockImplementationOnce(async () => {
          mockFiles.set(
            '/tmp/repo-a/src/example.ts',
            'export const formatted = true;\n',
          );

          return {
            command: 'npm run lint',
            exitCode: 1,
            stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
            stderr: '',
          };
        })
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

      await agent.execute(ticketArtifact, buildPlan({}), {
        platformName: 'jira',
        repoDir: '/tmp/repo-a',
      });

      expect(aiService.generateFileChange).toHaveBeenCalledTimes(2);
    });
  });
});
