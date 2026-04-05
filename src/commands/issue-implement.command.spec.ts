// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold',
      'dim',
      'italic',
      'underline',
      'inverse',
      'strikethrough',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
    ].forEach((name) => {
      chain[name] = identity;
    });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    ),
  };
});

import { Test } from '@nestjs/testing';
import { IssueImplementCommand } from './issue-implement.command';
import { AiService } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import * as os from 'os';
import * as path from 'path';

async function buildCommand(): Promise<IssueImplementCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueImplementCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
      { provide: PlatformService, useValue: {} },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue('jira') },
      },
      {
        provide: LoggerService,
        useValue: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          success: jest.fn(),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
          previewGitOperation: jest.fn(),
        },
      },
      {
        provide: AgentOrchestrator,
        useValue: {
          implementer: { execute: jest.fn() },
          planner: { execute: jest.fn() },
        },
      },
    ],
  }).compile();
  return module.get(IssueImplementCommand);
}

describe('IssueImplementCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/consumer-app');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const command = await buildCommand();

      expect(
        command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any),
      ).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('option metadata', () => {
    it('does not expose a --force-recreate option', () => {
      const proto = IssueImplementCommand.prototype as any;
      expect(proto.parseForceRecreate).toBeUndefined();
    });

    it('does not expose --plan or --format options', () => {
      const proto = IssueImplementCommand.prototype as any;
      expect(proto.parsePlan).toBeUndefined();
      expect(proto.parseFormat).toBeUndefined();
    });
  });

  describe('custom plan identifier validation', () => {
    it('rejects unsupported file extensions for non-ticket identifiers', async () => {
      const command = await buildCommand();
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      await command.run(['merry-tinkering-pine-feature.txt'], {
        dryRun: true,
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(
        consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
      ).toContain('supported file extension');

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('resolves a custom plan stem by finding the matching supported artifact', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(
            path.join('.wf', 'repo-a', 'dark-building-creek-fix.json'),
          ),
        );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'fix',
          summary: 'Repair the custom implementation path',
          steps: ['Route custom plans to the shared implementer'],
          filesAffected: ['repo-a/src/commands/issue-implement.command.ts'],
          repositoriesAffected: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-fix'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(
            os.homedir(),
            '.wf',
            'repo-a',
            'dark-building-creek-fix.json',
          ),
        }),
      );
    });
  });

  describe('Mode C — preflight checks (live path)', () => {
    let command: IssueImplementCommand;
    let exitSpy: jest.SpyInstance;
    let existsSyncSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(async () => {
      command = await buildCommand();
      exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('exits with code 1 and prints fetch hint when ticket artifact is missing', async () => {
      existsSyncSpy.mockReturnValue(false);

      await command.run(['WBP-0001'], { repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain('Ticket artifact not found');
      expect(errorOutput).toContain('issue:fetch');
      expect(errorOutput).toContain(
        path.join(os.homedir(), '.wf', 'repo-a', 'jira', 'WBP-0001.md'),
      );
      expect(errorOutput).toContain('--repos repo-a');
      expect(errorOutput).not.toContain('--repos repo-a,');
    });

    it('exits with code 1 and prints plan hint when ticket exists but plan is missing', async () => {
      existsSyncSpy.mockImplementation((p: string) =>
        String(p).endsWith('WBP-0001.md'),
      );

      await command.run(['WBP-0001'], { repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain('No plan artifact found');
      expect(errorOutput).toContain('issue:plan');
      expect(errorOutput).toContain('issue:implement');
      expect(errorOutput).toContain('--repos repo-a');
      expect(errorOutput).not.toContain('--repos repo-a,');
    });
  });

  describe('Mode C — dry-run path', () => {
    let command: IssueImplementCommand;
    let exitSpy: jest.SpyInstance;
    let existsSyncSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;
    let dryRunPreview: jest.Mocked<DryRunPreviewService>;

    beforeEach(async () => {
      command = await buildCommand();
      exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
      dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('exits with code 1 and does not render preview when ticket artifact is missing', async () => {
      existsSyncSpy.mockReturnValue(false);

      await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
    });

    it('exits with code 1 and does not render preview when plan artifact is missing', async () => {
      existsSyncSpy.mockImplementation((p: string) =>
        String(p).endsWith('.md'),
      );

      await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
    });

    it('previews two file-reads and shows summary with zero counts when both artifacts exist (feature plan)', async () => {
      // Allow ticket .md and only the feature plan so discoverPlanAction resolves
      // to action='feature' (investigate is first in candidates and would win with
      // equal mtimeMs if we simply mockReturnValue(true)).
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md') ||
          String(p).endsWith('WBP-0001-plan-feature.json'),
      );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);

      await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(dryRunPreview.previewFileRead).toHaveBeenCalledTimes(2);
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({ apiCallCount: 0, fileCreatedCount: 0 }),
      );
    });

    it('shows apiCallCount: 1 and fileCreatedCount: 1 for investigate plan dry-run', async () => {
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md') ||
          String(p).endsWith('WBP-0001-plan-investigate.json'),
      );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue(JSON.stringify({ action: 'investigate' }));

      await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({ apiCallCount: 1, fileCreatedCount: 1 }),
      );
    });
  });

  describe('custom plan mode', () => {
    it('resolves a custom filename from the repo custom namespace in dry-run mode', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(
            path.join('.wf', 'repo-a', 'merry-tinkering-pine-feature.json'),
          ),
        );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue(JSON.stringify({ action: 'feature', steps: [] }));

      await command.run(['merry-tinkering-pine-feature.json'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(
            os.homedir(),
            '.wf',
            'repo-a',
            'merry-tinkering-pine-feature.json',
          ),
        }),
      );
    });

    it('calls the implementer for a custom fix plan using a synthetic execution context', async () => {
      const command = await buildCommand();
      const consoleWarnSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(
            path.join('.wf', 'repo-a', 'dark-building-creek-fix.json'),
          ),
        );
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'fix',
          summary: 'Repair the failing custom workflow',
          steps: ['Update the implement command'],
          filesAffected: ['repo-a/src/commands/issue-implement.command.ts'],
          repositoriesAffected: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-fix.json'], {
        repos: ['repo-a'],
      });

      const mockOrchestrator = (command as any)
        .orchestrator as jest.Mocked<AgentOrchestrator>;
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketKey: 'dark-building-creek',
          path: path.join(
            os.homedir(),
            '.wf',
            'repo-a',
            'dark-building-creek-fix.json',
          ),
          content: expect.stringContaining('# dark-building-creek:'),
        }),
        expect.objectContaining({
          action: 'fix',
          path: path.join(
            os.homedir(),
            '.wf',
            'repo-a',
            'dark-building-creek-fix.json',
          ),
        }),
        expect.objectContaining({
          platformName: 'jira',
          repoDir: '/tmp/consumer-app/repo-a',
          customBranchSlug: 'dark-building-creek',
        }),
      );
      expect(
        consoleWarnSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'synthetic execution context for custom plan',
          ),
        ),
      ).toBe(true);

      consoleWarnSpy.mockRestore();
    });

    it('previews branch and file work for a custom feature dry-run', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(
            path.join('.wf', 'repo-a', 'dark-building-creek-feature.json'),
          ),
        );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'feature',
          summary: 'Implement the custom workflow',
          steps: ['Update the implement command'],
          filesAffected: ['repo-a/src/commands/issue-implement.command.ts'],
          repositoriesAffected: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-feature.json'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath:
            '/tmp/consumer-app/repo-a/src/commands/issue-implement.command.ts',
          operation: 'create',
        }),
      );
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          gitOperationCount: 1,
          fileCreatedCount: 1,
          terminalOutputLines: expect.arrayContaining([
            expect.stringContaining('Synthetic execution context'),
            expect.stringContaining('Branch: feature/dark-building-creek'),
          ]),
        }),
      );
    });
  });

  describe('standard plan format support', () => {
    it('loads a markdown standard plan artifact when json is absent', async () => {
      const mockOrchestrator = {
        implementer: { execute: jest.fn().mockResolvedValue(undefined) },
        planner: { execute: jest.fn() },
      };
      const module = await Test.createTestingModule({
        providers: [
          IssueImplementCommand,
          {
            provide: AiService,
            useValue: {
              getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
            },
          },
          { provide: PlatformService, useValue: {} },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue('jira') },
          },
          {
            provide: LoggerService,
            useValue: {
              info: jest.fn(),
              warn: jest.fn(),
              error: jest.fn(),
              success: jest.fn(),
            },
          },
          {
            provide: DryRunPreviewService,
            useValue: {
              showHeader: jest.fn(),
              showSummary: jest.fn(),
              showValidationResult: jest.fn(),
              previewApiCall: jest.fn(),
              previewFileRead: jest.fn(),
              previewFileWrite: jest.fn(),
              previewGitOperation: jest.fn(),
            },
          },
          { provide: AgentOrchestrator, useValue: mockOrchestrator },
        ],
      }).compile();
      const command = module.get(IssueImplementCommand);

      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) => {
          const filePath = String(input);
          return (
            filePath.endsWith('WBP-0001.md') ||
            filePath.endsWith('WBP-0001-plan-feature.md')
          );
        });
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest
        .spyOn(require('fs').promises, 'readFile')
        .mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue(
          [
            '# Implementation Plan',
            '',
            '**Action:** feature',
            '**Complexity:** medium',
            '',
            '## Summary',
            '',
            'Plan summary',
            '',
            '## Steps',
            '',
            '1. First step',
          ].join('\n'),
        );

      await command.run(['WBP-0001'], { repos: ['repo-a'] });

      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      const [, planArg] = mockOrchestrator.implementer.execute.mock.calls[0];
      expect(planArg.path).toBe(
        path.join(
          os.homedir(),
          '.wf',
          'repo-a',
          'jira',
          'WBP-0001-plan-feature.md',
        ),
      );
      expect(planArg.plan.steps).toEqual(['First step']);
    });
  });

  // Keep the happy-path live test inside its own describe
  describe('Mode C — happy path (live)', () => {
    let exitSpy: jest.SpyInstance;
    let existsSyncSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('reads ticket and plan from disk and calls implementer when both artifacts exist', async () => {
      // Allow ticket .md and only the feature plan so discoverPlanAction resolves
      // to action='feature' (investigate is first in the candidates array and would
      // win when all mtimeMs are equal if we simply mockReturnValue(true)).
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md') ||
          String(p).endsWith('WBP-0001-plan-feature.json'),
      );
      // statSync is called by discoverPlanAction's sort — prevent real fs access
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest
        .spyOn(require('fs').promises, 'readFile')
        .mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue(JSON.stringify({ action: 'feature', steps: [] }));

      const mockOrchestrator = {
        implementer: { execute: jest.fn().mockResolvedValue(undefined) },
        planner: { execute: jest.fn() },
      };
      const module = await Test.createTestingModule({
        providers: [
          IssueImplementCommand,
          { provide: AiService, useValue: {} },
          { provide: PlatformService, useValue: {} },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue('jira') },
          },
          {
            provide: LoggerService,
            useValue: {
              info: jest.fn(),
              warn: jest.fn(),
              error: jest.fn(),
              success: jest.fn(),
            },
          },
          {
            provide: DryRunPreviewService,
            useValue: {
              showHeader: jest.fn(),
              showSummary: jest.fn(),
              showValidationResult: jest.fn(),
              previewApiCall: jest.fn(),
              previewFileRead: jest.fn(),
              previewFileWrite: jest.fn(),
              previewGitOperation: jest.fn(),
            },
          },
          { provide: AgentOrchestrator, useValue: mockOrchestrator },
        ],
      }).compile();
      const cmd = module.get(IssueImplementCommand);

      await cmd.run(['WBP-0001'], { repos: ['repo-a'] });

      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      const [ticketArg, planArg] =
        mockOrchestrator.implementer.execute.mock.calls[0];
      expect(ticketArg.ticketKey).toBe('WBP-0001');
      expect(ticketArg.path).toBe(
        path.join(os.homedir(), '.wf', 'repo-a', 'jira', 'WBP-0001.md'),
      );
      expect(planArg.action).toBe('feature');
      expect(planArg.path).toBe(
        path.join(
          os.homedir(),
          '.wf',
          'repo-a',
          'jira',
          'WBP-0001-plan-feature.json',
        ),
      );
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          platformName: 'jira',
          repoDir: '/tmp/consumer-app/repo-a',
        }),
      );
      // planner was never called — plan was loaded from disk
      expect(mockOrchestrator.planner.execute).not.toHaveBeenCalled();
    });
  });

  describe('ticket mode with multiple repos', () => {
    it('warns that only the first repository will be verified', async () => {
      const command = await buildCommand();
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const existsSyncSpy = jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation(
          (p: string) =>
            String(p).endsWith('WBP-0001.md') ||
            String(p).endsWith('WBP-0001-plan-feature.json'),
        );
      jest
        .spyOn(require('fs'), 'statSync')
        .mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest
        .spyOn(require('fs').promises, 'readFile')
        .mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue(JSON.stringify({ action: 'feature', steps: [] }));

      await command.run(['WBP-0001'], { repos: ['repo-a', 'repo-b'] });

      expect(
        consoleSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'issue:implement verifies only the first repository',
          ),
        ),
      ).toBe(true);

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});
