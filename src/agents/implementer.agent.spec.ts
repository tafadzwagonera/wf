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
                    baseMaxAttempts: 3,
                    maxProgressExtensions: 2,
                    absoluteMaxAttempts: 5,
                    fingerprintLineCount: 5,
                    requireStateChangeForRetry: true,
                    retryOnSameFailure: false,
                    scripts: {
                      formatWrite: 'npm run format:write',
                      formatCheck: 'npm run format:check',
                      lintFix: 'npm run lint:fix',
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

  describe('custom branch slug', () => {
    it('uses the custom branch slug when provided for non-ticket execution contexts', async () => {
      jest
        .spyOn(agent as any, 'prepareVerificationScripts')
        .mockReturnValue([]);

      await agent.execute(ticketArtifact, buildPlan({ filesAffected: [] }), {
        platformName: 'jira',
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

  describe('verification loop', () => {
    const installMockRepoFiles = () => {
      const mockFiles = new Map<string, string>([
        [
          '/tmp/repo-a/package.json',
          JSON.stringify({
            scripts: {
              'format:write': 'prettier --write .',
              'format:check': 'prettier --check .',
              'lint:fix': 'eslint . --fix',
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
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
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
        'npm run format:write',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        2,
        'npm run format:check',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        3,
        'npm run lint:fix',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        4,
        'npm run lint',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        5,
        'npm run build',
        '/tmp/repo-a',
      );
    });

    it('merges manifest baseline with plan targeted checks and skips waived baseline checks', async () => {
      const mockFiles = installMockRepoFiles();
      mockFiles.set(
        '/tmp/repo-a/.wf/verification.json',
        JSON.stringify({
          version: 1,
          baseline: [
            { id: 'lint', run: 'npm run lint', policy: 'enforced' },
            { id: 'build', run: 'npm run build', policy: 'enforced' },
            { id: 'e2e', run: 'npm run test:e2e', policy: 'enforced' },
          ],
        }),
      );

      const configService = (agent as any).configService as ConfigService;
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            'branching.prefixMapping': {
              feature: 'feature',
              fix: 'bugfix',
              investigate: 'chore',
            },
            'stages.implement.afterImplement': {
              baseMaxAttempts: 3,
              maxProgressExtensions: 2,
              absoluteMaxAttempts: 5,
              fingerprintLineCount: 5,
              requireStateChangeForRetry: true,
              retryOnSameFailure: false,
              policyFile: '.wf/verification.json',
              scripts: {},
            },
          };

          return key in values ? values[key] : fallback;
        });

      const runCommandSpy = jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValue({
          command: 'ok',
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

      await agent.execute(
        ticketArtifact,
        buildPlan({
          verification: {
            targeted: [
              {
                id: 'manual-review',
                run: 'npm run test:manual -- test-issue-review',
                policy: 'enforced',
              },
            ],
            waivers: [
              {
                id: 'e2e',
                reason: 'Docs-only change',
              },
            ],
          } as any,
        } as any),
        {
          platformName: 'jira',
          repoDir: '/tmp/repo-a',
        },
      );

      expect(runCommandSpy.mock.calls.map((call) => call[0])).toEqual([
        'npm run lint',
        'npm run build',
        'npm run test:manual -- test-issue-review',
      ]);
    });

    it('retries with the full configured script sequence after actionable failures', async () => {
      installMockRepoFiles();

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const fixed = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 1,
          stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
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

    it('extends retries beyond the base budget when verification advances to a later stage', async () => {
      installMockRepoFiles();

      const configService = (agent as any).configService as ConfigService;
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            'branching.prefixMapping': {
              feature: 'feature',
              fix: 'bugfix',
              investigate: 'chore',
            },
            'stages.implement.afterImplement': {
              baseMaxAttempts: 2,
              maxProgressExtensions: 2,
              absoluteMaxAttempts: 4,
              fingerprintLineCount: 5,
              requireStateChangeForRetry: true,
              retryOnSameFailure: false,
              scripts: {
                formatWrite: 'npm run format:write',
                formatCheck: 'npm run format:check',
                lintFix: 'npm run lint:fix',
                lint: 'npm run lint',
                build: 'npm run build',
              },
            },
          };

          return key in values ? values[key] : fallback;
        });

      aiService.generateFileChange
        .mockResolvedValueOnce('export const invalid = true;\n')
        .mockResolvedValueOnce('export const typed = true;\n')
        .mockResolvedValueOnce('export const built = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 1,
          stdout:
            'Checking formatting...\n[src/example.ts] Code style issues found',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint',
          exitCode: 1,
          stdout: 'src/example.ts:1:1 - error TS2322: Type mismatch',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
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

      expect(aiService.generateFileChange).toHaveBeenCalledTimes(3);
    });

    it('stops retrying when the AI does not produce a state change after a failure', async () => {
      installMockRepoFiles();

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const broken = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
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
            command: 'npm run format:write',
            exitCode: 1,
            stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
            stderr: '',
          };
        })
        .mockResolvedValueOnce({
          command: 'npm run format:write',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run format:check',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npm run lint:fix',
          exitCode: 0,
          stdout: '',
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
    });
  });
});
