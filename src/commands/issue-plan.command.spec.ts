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
import { ConfigService } from '@nestjs/config';
import { IssuePlanCommand } from './issue-plan.command';
import { AiService } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import * as os from 'os';
import * as path from 'path';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(): Promise<{
  command: IssuePlanCommand;
  fetchStageService: jest.Mocked<FetchStageService>;
  planStageService: jest.Mocked<PlanStageService>;
}> {
  const module = await Test.createTestingModule({
    providers: [
      IssuePlanCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
      { provide: PlatformService, useValue: {} },
      {
        provide: FetchStageService,
        useValue: {
          fetchArtifact: jest.fn(),
          loadArtifact: jest.fn(),
        },
      },
      {
        provide: PlanStageService,
        useValue: {
          generatePlan: jest.fn(),
        },
      },
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
    ],
  }).compile();

  return {
    command: module.get(IssuePlanCommand),
    fetchStageService: module.get(FetchStageService),
    planStageService: module.get(PlanStageService),
  };
}

describe('IssuePlanCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(
        command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any),
      ).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('option metadata', () => {
    it('does not expose a --prompt option', () => {
      const proto = IssuePlanCommand.prototype as any;
      expect(proto.parsePrompt).toBeUndefined();
    });
  });

  it('stores custom-mode plans under the cwd custom namespace when --repos is absent', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      custom: 'bar.md',
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(
      path.join(os.homedir(), '.wf', 'consumer-app', 'bar.md'),
    );
    expect(path.dirname(writePreview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'consumer-app'),
    );
  });

  it('stores custom-mode plans under the targeted repo custom namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      custom: 'bar.md',
      repos: ['repo-a'],
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(
      path.join(os.homedir(), '.wf', 'repo-a', 'bar.md'),
    );
    expect(path.dirname(writePreview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'repo-a'),
    );
  });

  it('rejects ticket-key + --custom together', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await command.run(['WBP-1'], {
      action: 'feature',
      custom: 'bar.md',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('--custom');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-markdown custom sources', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await command.run([], {
      action: 'feature',
      custom: 'jira/bar.yaml',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('Markdown');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('stores ticket-mode plans under the targeted repo namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      action: 'fix',
      repos: ['repo-a'],
      dryRun: true,
    });

    const ticketPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'repo-a', 'jira');

    expect(path.dirname(ticketPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('stores ticket-mode plans under the repo-name namespace for long-format repos', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      action: 'fix',
      repos: ['workspace/repo-a'],
      dryRun: true,
    });

    const ticketPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'repo-a', 'jira');

    expect(path.dirname(ticketPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('delegates ticket retrieval and plan generation to stage services in live ticket mode', async () => {
    const { command, fetchStageService, planStageService } =
      await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['src/auth.ts'],
    } as any);

    const writeFileSpy = jest
      .spyOn(require('fs').promises, 'writeFile')
      .mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(fetchStageService.fetchArtifact).toHaveBeenCalledWith('WBP-1', {
      platformName: 'jira',
      repo: 'repo-a',
      baseDir: '/tmp/consumer-app/repo-a',
    });
    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      {
        action: 'fix',
        ticketKey: 'WBP-1',
        affectedRepositories: undefined,
      },
    );
    expect(writeFileSpy).toHaveBeenCalled();
  });

  it('deletes sibling standard plans before writing a new ticket plan', async () => {
    const { command, fetchStageService, planStageService } =
      await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['src/auth.ts'],
    } as any);

    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation((input: string) => {
        const filePath = String(input);
        return (
          filePath.endsWith('WBP-1.md') ||
          filePath.endsWith('WBP-1-plan-feature.json') ||
          filePath.endsWith('WBP-1-plan-investigate.md')
        );
      });
    const unlinkSyncSpy = jest
      .spyOn(require('fs'), 'unlinkSync')
      .mockImplementation(() => {});
    jest
      .spyOn(require('fs').promises, 'writeFile')
      .mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(
        os.homedir(),
        '.wf',
        'repo-a',
        'jira',
        'WBP-1-plan-feature.json',
      ),
    );
    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(
        os.homedir(),
        '.wf',
        'repo-a',
        'jira',
        'WBP-1-plan-investigate.md',
      ),
    );
  });
});
