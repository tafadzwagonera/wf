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
              .mockImplementation((key: string, fallback?: string) =>
                key === 'branching.prefixMapping'
                  ? { feature: 'feature', fix: 'bugfix', investigate: 'chore' }
                  : fallback,
              ),
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
    it('runs format, lint, tsc, and nr build in the selected repo after generating files', async () => {
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((filePath: string) => {
          if (filePath === '/tmp/repo-a/src/example.ts') return true;
          return filePath === '/tmp/repo-a/package.json';
        });
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockImplementation((filePath: string) => {
          if (filePath === '/tmp/repo-a/package.json') {
            return JSON.stringify({
              scripts: {
                format: 'prettier --write .',
                lint: 'eslint .',
                build: 'tsc -p .',
              },
            });
          }
          return 'export const value = 0;\n';
        });
      jest
        .spyOn(require('fs'), 'mkdirSync')
        .mockImplementation(() => undefined as any);
      jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => undefined);

      const runCommandSpy = jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'nr format',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'nr lint',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npx tsc --noEmit --pretty 2>&1 | head -n 200',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'nr build',
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
        'nr format',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        2,
        'nr lint',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        3,
        'npx tsc --noEmit --pretty 2>&1 | head -n 200',
        '/tmp/repo-a',
      );
      expect(runCommandSpy).toHaveBeenNthCalledWith(
        4,
        'nr build',
        '/tmp/repo-a',
      );
    });

    it('retries file generation with verification diagnostics until checks pass', async () => {
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((filePath: string) => {
          if (filePath === '/tmp/repo-a/src/example.ts') return true;
          return filePath === '/tmp/repo-a/package.json';
        });
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockImplementation((filePath: string) => {
          if (filePath === '/tmp/repo-a/package.json') {
            return JSON.stringify({
              scripts: { build: 'tsc -p .' },
            });
          }
          return 'export const value = 0;\n';
        });
      jest
        .spyOn(require('fs'), 'mkdirSync')
        .mockImplementation(() => undefined as any);
      jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => undefined);

      aiService.generateFileChange
        .mockResolvedValueOnce('export const broken = true;\n')
        .mockResolvedValueOnce('export const fixed = true;\n');

      jest
        .spyOn(agent as any, 'runCommand')
        .mockResolvedValueOnce({
          command: 'npx tsc --noEmit --pretty 2>&1 | head -n 200',
          exitCode: 1,
          stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'npx tsc --noEmit --pretty 2>&1 | head -n 200',
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'nr build',
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
  });
});
