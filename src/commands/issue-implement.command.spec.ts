// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
      'white', 'gray', 'grey',
    ].forEach((name) => { chain[name] = identity; });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

import { Test } from '@nestjs/testing';
import { IssueImplementCommand } from './issue-implement.command';
import { AiService } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';

async function buildCommand(): Promise<IssueImplementCommand> {
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
  describe('option metadata', () => {
    it('does not expose a --force-recreate option', () => {
      const proto = IssueImplementCommand.prototype as any;
      expect(proto.parseForceRecreate).toBeUndefined();
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
    });

    it('exits with code 1 and prints plan hint when ticket exists but plan is missing', async () => {
      // .md paths → ticket exists; .json paths → plan does not exist
      existsSyncSpy.mockImplementation((p: string) =>
        String(p).endsWith('.md'),
      );

      await command.run(['WBP-0001'], { repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain('No plan artifact found');
      expect(errorOutput).toContain('issue:plan');
      expect(errorOutput).toContain('issue:implement');
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
      existsSyncSpy.mockImplementation((p: string) =>
        !String(p).includes('-plan-investigate.json') &&
        !String(p).includes('-plan-fix.json'),
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
      existsSyncSpy.mockImplementation((p: string) =>
        String(p).endsWith('.md') ||
        String(p).includes('-plan-investigate.json'),
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
      existsSyncSpy.mockImplementation((p: string) =>
        !String(p).includes('-plan-investigate.json') &&
        !String(p).includes('-plan-fix.json'),
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
      expect(planArg.action).toBe('feature');
      // planner was never called — plan was loaded from disk
      expect(mockOrchestrator.planner.execute).not.toHaveBeenCalled();
    });
  });
});
