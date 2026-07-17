// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    for (const name of [
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
    ]) {
      chain[name] = identity;
    }
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('../shared/utils/ensure-wf-home', () => ({
  ensureWfHome: jest.fn(),
}));

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    ),
  };
});

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CommandMeta } from 'nest-commander/src/constants';
import { IssueCommand } from './issue.command';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import { AiService } from '../integrations/ai/ai.service';
import { SessionService } from '../shared/session/session.service';
import { SummaryService } from '../shared/session/summary.service';
import { buildPlanArtifactManifestPath, hashPlanArtifactSources } from '../shared/utils/plan-artifact';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inquirer from 'inquirer';

const mockSessionService = {
  load: jest.fn().mockResolvedValue(null),
  save: jest.fn().mockResolvedValue(undefined),
  findByTicketKey: jest.fn().mockResolvedValue(null),
  recordStageStart: jest.fn().mockImplementation(session => Promise.resolve(session)),
  recordProviderSessionId: jest.fn().mockImplementation(session => Promise.resolve(session)),
  recordStageComplete: jest.fn().mockImplementation(session => Promise.resolve(session)),
  markComplete: jest.fn().mockImplementation(session => Promise.resolve(session)),
  validateForStage: jest
    .fn()
    .mockReturnValue({ canResume: false, resumableProviderSessionId: null, priorSummary: null, warnings: [] }),
  isExpired: jest.fn().mockReturnValue(false),
  getSessionDir: jest.fn().mockReturnValue('/tmp/sessions'),
};

const mockSummaryService = {
  generateStageSummary: jest.fn().mockResolvedValue('Mock stage summary'),
};

const mockCwd = '/tmp/consumer-app';

const setInteractiveSession = (): void => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });
};

async function buildCommand(): Promise<IssueCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueCommand,
      { provide: ConversationService, useValue: {} },
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
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'tracker') return 'jira';
            if (key === 'ai.provider') return 'openai';
            return defaultValue;
          }),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showStageHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          showSkipped: jest.fn(),
          showNoSideEffects: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
      { provide: AgentOrchestrator, useValue: {} },
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
      { provide: SessionService, useValue: mockSessionService },
      { provide: SummaryService, useValue: mockSummaryService },
    ],
  }).compile();

  return module.get(IssueCommand);
}

describe('IssueCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  it('registers the command as issue', () => {
    const metadata = Reflect.getMetadata(CommandMeta, IssueCommand) as {
      name: string;
    };

    expect(metadata.name).toBe('issue');
  });

  it('rejects plan-token + --custom-plan together', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['dark-plan.json'], {
      customPlan: 'bar.md',
      from: 'plan',
      action: 'fix',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--custom-plan');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects plan-token with --from fetch', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['2026-05-04-abc123-fix-plan.json'], {
      from: 'fetch',
      action: 'fix',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--from implement');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects plan-token with --from plan', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['2026-05-04-def456-fix-plan.json'], {
      from: 'plan',
      action: 'fix',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--from implement');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('defaults --from to implement when a plan token is provided', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await command.run(['2026-05-04-abc123-fix-plan.json'], {} as any);

    const errorOutput = consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(errorOutput).not.toContain('--from option is required');

    const logOutput = consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logOutput).toContain('Stages:');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('defaults --from to plan when --custom-plan is provided', async () => {
    const command = await buildCommand();
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await command.run([], {
      customPlan: 'plan.md',
      action: 'fix',
      to: 'plan',
    } as any);

    const errorOutput = consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(errorOutput).not.toContain('--from option is required');

    const logOutput = consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logOutput).toContain('Stages:');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('rejects --custom-plan with non-.md extension', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {
      customPlan: 'bar.yaml',
      from: 'plan',
      action: 'fix',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('.md');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('stores default artifacts under the cwd namespace in dry-run mode', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);

    await command.run([], {
      ticketKey: 'WBP-1',
      from: 'fetch',
      to: 'plan',
      action: 'fix',
      dryRun: true,
    });

    const fetchPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'consumer-app', 'jira');

    expect(path.dirname(fetchPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('stores repo-scoped artifacts under the targeted repo namespace in dry-run mode', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);

    await command.run([], {
      ticketKey: 'WBP-1',
      from: 'fetch',
      to: 'plan',
      action: 'fix',
      repos: ['repo-a'],
      dryRun: true,
    });

    const fetchPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'repo-a', 'jira');

    expect(path.dirname(fetchPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('resolves a hashed plan token when resuming from implement without --action', async () => {
    const hash = hashPlanArtifactSources(['WBP-1']);
    const artifactDir = path.join(os.homedir(), '.wf', 'repo-a', 'jira');
    const ticketPath = path.join(artifactDir, 'WBP-1.md');
    const planPath = path.join(artifactDir, `2026-04-16-${hash}-fix-plan.json`);
    const manifestPath = buildPlanArtifactManifestPath(planPath);
    const ticketMarkdown = '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow';

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-1',
          content: ticketMarkdown,
          path: ticketPath,
        }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Repair the cached plan',
            estimatedComplexity: 'medium',
            steps: ['Patch the login flow'],
            affectedFiles: ['repo-a/src/auth.ts'],
            affectedRepositories: ['repo-a'],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
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
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: {
            getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
          },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation(
        (input: string) =>
          String(input) === ticketPath
          || String(input) === planPath
          || String(input) === manifestPath
          || String(input) === artifactDir,
      );
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(manifestPath)] as any);
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === ticketPath) {
        return ticketMarkdown;
      }
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'ticket',
          sourceName: 'WBP-1',
          ticketKey: 'WBP-1',
        });
      }
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Repair the cached plan',
          estimatedComplexity: 'medium',
          steps: ['Patch the login flow'],
          affectedFiles: ['repo-a/src/auth.ts'],
          affectedRepositories: ['repo-a'],
        });
      }
      return '';
    });

    await command.run([`2026-04-16-${hash}-fix-plan.json`], {
      from: 'implement',
      to: 'implement',
      repos: ['repo-a'],
    });

    expect(mockOrchestrator.fetcher.loadFromDisk).toHaveBeenCalledWith(
      'WBP-1',
      'jira',
      path.join('/tmp/consumer-app', 'repo-a'),
      undefined,
    );
    expect(mockOrchestrator.planner.loadFromDisk).toHaveBeenCalledWith(ticketPath, undefined, undefined);
    expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: 'WBP-1' }),
      expect.objectContaining({ action: 'fix', path: planPath }),
      expect.objectContaining({ trackerName: 'jira' }),
    );
  });

  it('resolves a plan token via direct file-path fallback when manifest-based resolution fails (no --repos)', async () => {
    const hash = hashPlanArtifactSources(['WBP-2']);
    const artifactDir = path.join(os.homedir(), '.wf', 'consumer-app', 'jira');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(artifactDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);
    const ticketPath = path.join(artifactDir, 'WBP-2.md');
    const ticketMarkdown = '# WBP-2: Fallback fix\n\n## Description\n\nTest fallback';

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-2',
          content: ticketMarkdown,
          path: ticketPath,
        }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Fallback plan',
            estimatedComplexity: 'low',
            steps: ['Apply patch'],
            affectedFiles: ['src/auth.ts'],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    // readdirSync returns empty — manifest scanner finds nothing
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    // existsSync succeeds for the direct plan path and its manifest
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation(
        (input: string) =>
          String(input) === planPath
          || String(input) === manifestPath
          || String(input) === ticketPath
          || String(input) === artifactDir,
      );
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'ticket',
          sourceName: 'WBP-2',
          ticketKey: 'WBP-2',
        });
      }
      if (filePath === ticketPath) return ticketMarkdown;
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Fallback plan',
          estimatedComplexity: 'low',
          steps: ['Apply patch'],
          affectedFiles: ['src/auth.ts'],
          affectedRepositories: [],
        });
      }
      return '';
    });

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(mockOrchestrator.fetcher.loadFromDisk).toHaveBeenCalledWith('WBP-2', 'jira', mockCwd, undefined);
  });

  it('resolves a plan token via direct file-path fallback when --repos is provided', async () => {
    const hash = hashPlanArtifactSources(['WBP-3']);
    const artifactDir = path.join(os.homedir(), '.wf', 'target-repo', 'jira');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(artifactDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);
    const ticketPath = path.join(artifactDir, 'WBP-3.md');
    const ticketMarkdown = '# WBP-3: Repo-scoped fallback\n\n## Description\n\nTest repo scope';

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-3',
          content: ticketMarkdown,
          path: ticketPath,
        }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Repo-scoped fallback plan',
            estimatedComplexity: 'low',
            steps: ['Apply repo patch'],
            affectedFiles: ['target-repo/src/main.ts'],
            affectedRepositories: ['target-repo'],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation(
        (input: string) =>
          String(input) === planPath
          || String(input) === manifestPath
          || String(input) === ticketPath
          || String(input) === artifactDir,
      );
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'ticket',
          sourceName: 'WBP-3',
          ticketKey: 'WBP-3',
        });
      }
      if (filePath === ticketPath) return ticketMarkdown;
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Repo-scoped fallback plan',
          estimatedComplexity: 'low',
          steps: ['Apply repo patch'],
          affectedFiles: ['target-repo/src/main.ts'],
          affectedRepositories: ['target-repo'],
        });
      }
      return '';
    });

    await command.run([planFilename], {
      from: 'implement',
      to: 'implement',
      repos: ['target-repo'],
    });

    expect(mockOrchestrator.fetcher.loadFromDisk).toHaveBeenCalledWith(
      'WBP-3',
      'jira',
      path.join('/tmp/consumer-app', 'target-repo'),
      undefined,
    );
  });

  it('resolves a plan token from the custom artifact directory when tracker directory has no match', async () => {
    const hash = hashPlanArtifactSources(['WBP-4']);
    const customDir = path.join(os.homedir(), '.wf', 'consumer-app');
    const trackerDir = path.join(customDir, 'jira');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);
    const ticketPath = path.join(trackerDir, 'WBP-4.md');
    const ticketMarkdown = '# WBP-4: Custom source\n\n## Description\n\nCustom plan';

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-4',
          content: ticketMarkdown,
          path: ticketPath,
        }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Custom source plan',
            estimatedComplexity: 'low',
            steps: ['Apply custom patch'],
            affectedFiles: ['src/custom.ts'],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    // trackerDir (jira/) has no manifests and no direct match
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation(
        (input: string) => String(input) === planPath || String(input) === manifestPath || String(input) === ticketPath,
      );
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'ticket',
          sourceName: 'WBP-4',
          ticketKey: 'WBP-4',
        });
      }
      if (filePath === ticketPath) return ticketMarkdown;
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Custom source plan',
          estimatedComplexity: 'low',
          steps: ['Apply custom patch'],
          affectedFiles: ['src/custom.ts'],
          affectedRepositories: [],
        });
      }
      return '';
    });

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(mockOrchestrator.fetcher.loadFromDisk).toHaveBeenCalledWith('WBP-4', 'jira', mockCwd, undefined);
  });

  it('prompts for provider session ID when resolving custom plan token in interactive session', async () => {
    const hash = hashPlanArtifactSources(['WBP-5']);
    const customDir = path.join(os.homedir(), '.wf', 'consumer-app');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-5',
          content: '# WBP-5\n\nTest',
          path: path.join('/tmp/consumer-app', 'jira', 'WBP-5.md'),
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    const sessionId = 'sess-abc123';
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation((input: string) => String(input) === planPath || String(input) === manifestPath);
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'custom',
          sourceName: 'WBP-5',
        });
      }
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Test plan',
          estimatedComplexity: 'low',
          steps: ['Step 1'],
          affectedFiles: ['src/test.ts'],
          affectedRepositories: [],
        });
      }
      return '';
    });

    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ providerSessionId: sessionId });
    setInteractiveSession();

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(inquirer.prompt).toHaveBeenCalled();
    // recordStageStart must be called before recordProviderSessionId so the stage record exists
    expect(mockSessionService.recordStageStart).toHaveBeenCalledWith(
      expect.any(Object),
      'plan',
      expect.objectContaining({ provider: expect.any(String), backend: expect.any(String) }),
      expect.any(String),
    );
    // expect.any(Object) — sessionState is created before the custom token block
    // updates ticketKey, so its ticketKey holds the filename, not the resolved sourceName.
    expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(expect.any(Object), 'plan', sessionId);
    expect(mockSessionService.recordStageComplete).toHaveBeenCalledWith(expect.any(Object), 'plan', 'Test plan');
  });

  it('skips provider session ID prompt when not in interactive session', async () => {
    const hash = hashPlanArtifactSources(['WBP-6']);
    const customDir = path.join(os.homedir(), '.wf', 'consumer-app');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-6',
          content: '# WBP-6\n\nTest',
          path: path.join('/tmp/consumer-app', 'jira', 'WBP-6.md'),
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation((input: string) => String(input) === planPath || String(input) === manifestPath);
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'custom',
          sourceName: 'WBP-6',
        });
      }
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Test plan',
          estimatedComplexity: 'low',
          steps: ['Step 1'],
          affectedFiles: ['src/test.ts'],
          affectedRepositories: [],
        });
      }
      return '';
    });

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    // Session lifecycle still runs even without the interactive prompt
    expect(mockSessionService.recordStageStart).toHaveBeenCalledWith(
      expect.any(Object),
      'plan',
      expect.any(Object),
      expect.any(String),
    );
    expect(mockSessionService.recordStageComplete).toHaveBeenCalledWith(expect.any(Object), 'plan', 'Test plan');
  });

  it('threads resumeProviderSessionId from validateForStage to implementer.execute', async () => {
    const hash = hashPlanArtifactSources(['WBP-7']);
    const customDir = path.join(os.homedir(), '.wf', 'consumer-app');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    const mockImplementerExecute = jest.fn().mockResolvedValue(undefined);
    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-7',
          content: '# WBP-7\n\nTest',
          path: path.join('/tmp/consumer-app', 'jira', 'WBP-7.md'),
        }),
      },
      implementer: { execute: mockImplementerExecute },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation((input: string) => String(input) === planPath || String(input) === manifestPath);
    jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
      const filePath = String(input);
      if (filePath === manifestPath) {
        return JSON.stringify({
          artifactPath: planPath,
          action: 'fix',
          createdAt: new Date('2026-06-30T00:00:00.000Z').toISOString(),
          format: 'json',
          hash,
          sourceKind: 'custom',
          sourceName: 'WBP-7',
        });
      }
      if (filePath === planPath) {
        return JSON.stringify({
          action: 'fix',
          summary: 'Test plan',
          estimatedComplexity: 'low',
          steps: ['Step 1'],
          affectedFiles: ['src/test.ts'],
          affectedRepositories: [],
        });
      }
      return '';
    });

    // Configure validateForStage to return a resumable session ID for the implement stage
    mockSessionService.validateForStage.mockReturnValue({
      canResume: true,
      resumableProviderSessionId: 'sess-plan-123',
      priorSummary: 'Plan summary from prior stage',
      warnings: [],
    });

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(mockSessionService.validateForStage).toHaveBeenCalledWith(
      expect.any(Object),
      'implement',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockImplementerExecute).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        resumeProviderSessionId: 'sess-plan-123',
        priorStageSummary: 'Plan summary from prior stage',
      }),
    );
    expect(mockSessionService.recordStageStart).toHaveBeenCalledWith(
      expect.any(Object),
      'implement',
      expect.any(Object),
      expect.any(String),
    );
    expect(mockSessionService.recordStageComplete).toHaveBeenCalledWith(expect.any(Object), 'implement', null);
  });

  it('persists new session to disk before executing stages', async () => {
    const mockOrchestrator = {
      fetcher: { execute: jest.fn().mockRejectedValue(new Error('fetch failed')) },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(command.run(['WBP-42'], { from: 'fetch', to: 'plan', action: 'fix' })).rejects.toThrow();

    // save() must have been called once (at creation) before the fetch error
    expect(mockSessionService.save).toHaveBeenCalledTimes(1);
    expect(mockSessionService.save).toHaveBeenCalledWith(expect.objectContaining({ stages: {}, ticketKey: 'WBP-42' }));
  });

  it('persists new session to disk even when no stages run successfully', async () => {
    const mockOrchestrator = {
      fetcher: { execute: jest.fn().mockRejectedValue(new Error('fetch failed')) },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(command.run(['WBP-99'], { from: 'fetch', to: 'plan', action: 'fix' })).rejects.toThrow();

    // save() called once at creation; recordStageComplete never reached because fetch failed
    expect(mockSessionService.save).toHaveBeenCalledTimes(1);
    expect(mockSessionService.recordStageComplete).not.toHaveBeenCalled();
  });

  it('prompts for provider session ID when plan is from cache', async () => {
    const ticketPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-20.md');
    const planPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-20-fix-plan.json');

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-20',
          content: '# WBP-20\n\nTest',
          path: ticketPath,
        }),
      },
      planner: {
        execute: jest.fn().mockResolvedValue({
          plan: {
            action: 'fix',
            summary: 'Cached plan',
            estimatedComplexity: 'low',
            steps: ['Step 1'],
            affectedFiles: ['src/test.ts'],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
          fromCache: true,
          sessionId: undefined,
        }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ providerSessionId: 'sess-cache-123' });
    setInteractiveSession();

    await command.run(['WBP-20'], { from: 'plan', to: 'plan', action: 'fix' });

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(
      expect.any(Object),
      'plan',
      'sess-cache-123',
    );
  });

  it('prompts for provider session ID when plan stage is skipped', async () => {
    const ticketPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-21.md');
    const planPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-21-fix-plan.json');

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-21',
          content: '# WBP-21\n\nTest',
          path: ticketPath,
        }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Skipped plan',
            estimatedComplexity: 'low',
            steps: ['Step 1'],
            affectedFiles: ['src/test.ts'],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: {
        execute: jest.fn().mockResolvedValue(undefined),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ providerSessionId: 'sess-skip-456' });
    setInteractiveSession();

    await command.run(['WBP-21'], { from: 'implement', to: 'implement' });

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(
      expect.any(Object),
      'plan',
      'sess-skip-456',
    );
  });

  it('records provider session ID into an existing wf session when plan is from cache', async () => {
    const ticketPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-22.md');
    const planPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-22-fix-plan.json');
    const existingSession = {
      sessionId: 'existing-uuid',
      ticketKey: 'WBP-22',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      stages: {},
    };

    mockSessionService.load.mockResolvedValueOnce(existingSession);

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({
          ticketKey: 'WBP-22',
          content: '# WBP-22\n\nTest',
          path: ticketPath,
        }),
      },
      planner: {
        execute: jest.fn().mockResolvedValue({
          plan: {
            action: 'fix',
            summary: 'Cached plan',
            estimatedComplexity: 'low',
            steps: ['Step 1'],
            affectedFiles: ['src/test.ts'],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
          fromCache: true,
          sessionId: undefined,
        }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ providerSessionId: 'sess-resume-789' });
    setInteractiveSession();

    await command.run(['WBP-22'], { from: 'plan', to: 'plan', action: 'fix', sessionId: 'existing-uuid' });

    expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'existing-uuid' }),
      'plan',
      'sess-resume-789',
    );
  });

  it('skips provider session ID prompt in non-interactive session when plan is from cache', async () => {
    const ticketPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-23.md');
    const planPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-23-fix-plan.json');

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({ ticketKey: 'WBP-23', content: '# WBP-23', path: ticketPath }),
      },
      planner: {
        execute: jest.fn().mockResolvedValue({
          plan: {
            action: 'fix',
            summary: 'Cached',
            estimatedComplexity: 'low',
            steps: [],
            affectedFiles: [],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
          fromCache: true,
          sessionId: undefined,
        }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await command.run(['WBP-23'], { from: 'plan', to: 'plan', action: 'fix' });

    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it('skips provider session ID prompt in non-interactive session when plan stage is skipped', async () => {
    const ticketPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-24.md');
    const planPath = path.join(os.homedir(), '.wf', 'consumer-app', 'jira', 'WBP-24-fix-plan.json');

    const mockOrchestrator = {
      fetcher: {
        loadFromDisk: jest.fn().mockReturnValue({ ticketKey: 'WBP-24', content: '# WBP-24', path: ticketPath }),
      },
      planner: {
        loadFromDisk: jest.fn().mockReturnValue({
          plan: {
            action: 'fix',
            summary: 'Skipped',
            estimatedComplexity: 'low',
            steps: [],
            affectedFiles: [],
            affectedRepositories: [],
          },
          action: 'fix',
          path: planPath,
        }),
      },
      implementer: { execute: jest.fn().mockResolvedValue(undefined) },
    };

    const module = await Test.createTestingModule({
      providers: [
        IssueCommand,
        { provide: ConversationService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'ai.provider') return 'openai';
              return defaultValue;
            }),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(),
            showStageHeader: jest.fn(),
            showSummary: jest.fn(),
            showValidationResult: jest.fn(),
            showSkipped: jest.fn(),
            showNoSideEffects: jest.fn(),
            previewApiCall: jest.fn(),
            previewFileRead: jest.fn(),
            previewFileWrite: jest.fn(),
          },
        },
        { provide: AgentOrchestrator, useValue: mockOrchestrator },
        {
          provide: AiService,
          useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') },
        },
        { provide: SessionService, useValue: mockSessionService },
        { provide: SummaryService, useValue: mockSummaryService },
      ],
    }).compile();
    const command = module.get(IssueCommand);

    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await command.run(['WBP-24'], { from: 'implement', to: 'implement' });

    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  describe('resolveCustomPlanToken action mismatch', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    });

    const buildPlanFile = (tempDir: string, planAction: string) => {
      const planPath = path.join(tempDir, `2026-04-16-abc123-${planAction}-plan.json`);
      const plan = {
        action: planAction,
        summary: 'Test plan',
        estimatedComplexity: 'low',
        steps: ['Step 1'],
        affectedFiles: [],
        affectedRepositories: [],
      };
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
      return { planPath, plan };
    };

    it('returns artifact with plan action when user picks it on custom token mismatch', async () => {
      const command = await buildCommand();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-token-'));
      const { planPath } = buildPlanFile(tempDir, 'investigate');
      setInteractiveSession();
      (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ selectedAction: 'investigate' });

      const result = await (command as any).resolveCustomPlanToken(
        { kind: 'custom', action: 'fix', artifactPath: planPath },
        undefined
      );

      expect(result).not.toBeNull();
      expect(result.action).toBe('investigate');
      expect(result.planArtifact.action).toBe('investigate');
      expect(result.planArtifact.plan.action).toBe('investigate');
    });

    it('returns artifact with requested action when user picks it on custom token mismatch', async () => {
      const command = await buildCommand();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-token-'));
      const { planPath } = buildPlanFile(tempDir, 'investigate');
      setInteractiveSession();
      (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ selectedAction: 'fix' });

      const result = await (command as any).resolveCustomPlanToken(
        { kind: 'custom', action: 'fix', artifactPath: planPath },
        undefined
      );

      expect(result).not.toBeNull();
      expect(result.action).toBe('fix');
      expect(result.planArtifact.action).toBe('fix');
    });

    it('throws ValidationError non-interactively when custom token action mismatches', async () => {
      const command = await buildCommand();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-token-'));
      const { planPath } = buildPlanFile(tempDir, 'investigate');

      await expect(
        (command as any).resolveCustomPlanToken(
          { kind: 'custom', action: 'fix', artifactPath: planPath },
          undefined
        )
      ).rejects.toThrow(/mismatch/i);

      await expect(
        (command as any).resolveCustomPlanToken(
          { kind: 'custom', action: 'fix', artifactPath: planPath },
          undefined
        )
      ).rejects.toThrow(/--action/);
    });

    it('skips validation when custom token action matches plan action', async () => {
      const command = await buildCommand();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-token-'));
      const { planPath } = buildPlanFile(tempDir, 'fix');

      const result = await (command as any).resolveCustomPlanToken(
        { kind: 'custom', action: 'fix', artifactPath: planPath },
        undefined
      );

      expect(result).not.toBeNull();
      expect(result.planArtifact.action).toBe('fix');
      expect(inquirer.prompt).not.toHaveBeenCalled();
    });
  });

  describe('assertEnforcedVerificationsPassed', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('does not throw when all outcomes passed', async () => {
      const command = await buildCommand();
      const outcomes = [
        { id: 'lint', command: 'yarn lint', policy: 'enforced' as const, status: 'passed' as const },
        { id: 'build', command: 'yarn build', policy: 'best_effort' as const, status: 'passed' as const },
      ];
      expect(() => (command as any).assertEnforcedVerificationsPassed(outcomes)).not.toThrow();
    });

    it('throws when an enforced verification failed', async () => {
      const command = await buildCommand();
      const outcomes = [
        { id: 'lint', command: 'yarn lint', policy: 'enforced' as const, status: 'failed' as const },
        { id: 'build', command: 'yarn build', policy: 'enforced' as const, status: 'passed' as const },
      ];
      expect(() => (command as any).assertEnforcedVerificationsPassed(outcomes)).toThrow(
        /enforced verification\(s\) failed/
      );
    });

    it('does not throw for best_effort failures, only warns', async () => {
      const command = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const outcomes = [
        { id: 'typecheck', command: 'yarn typecheck', policy: 'best_effort' as const, status: 'failed' as const },
      ];
      expect(() => (command as any).assertEnforcedVerificationsPassed(outcomes)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('yarn typecheck'));
    });

    it('throws with a message referencing wf issue --from implement', async () => {
      const command = await buildCommand();
      const outcomes = [
        { id: 'lint', command: 'yarn lint', policy: 'enforced' as const, status: 'failed' as const },
      ];
      expect(() => (command as any).assertEnforcedVerificationsPassed(outcomes)).toThrow(
        /--from implement/
      );
    });

    it('does not throw when outcomes is empty', async () => {
      const command = await buildCommand();
      expect(() => (command as any).assertEnforcedVerificationsPassed([])).not.toThrow();
    });
  });
});
