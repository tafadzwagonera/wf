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
    ].forEach(name => {
      chain[name] = identity;
    });
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
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app'
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
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    (inquirer.prompt as unknown as jest.Mock).mockClear();
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

  it('stores default artifacts under the cwd namespace in dry-run mode', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);

    await command.run(['WBP-1'], {
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

    await command.run(['WBP-1'], {
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
          String(input) === ticketPath ||
          String(input) === planPath ||
          String(input) === manifestPath ||
          String(input) === artifactDir
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
      undefined
    );
    expect(mockOrchestrator.planner.loadFromDisk).toHaveBeenCalledWith(ticketPath, undefined, undefined);
    expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: 'WBP-1' }),
      expect.objectContaining({ action: 'fix', path: planPath }),
      expect.objectContaining({ trackerName: 'jira' })
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
          String(input) === planPath ||
          String(input) === manifestPath ||
          String(input) === ticketPath ||
          String(input) === artifactDir
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
          String(input) === planPath ||
          String(input) === manifestPath ||
          String(input) === ticketPath ||
          String(input) === artifactDir
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
      undefined
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
        (input: string) => String(input) === planPath || String(input) === manifestPath || String(input) === ticketPath
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
      expect.any(String)
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
      expect.any(String)
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
      expect.any(Function)
    );
    expect(mockImplementerExecute).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        resumeProviderSessionId: 'sess-plan-123',
        priorStageSummary: 'Plan summary from prior stage',
      })
    );
    expect(mockSessionService.recordStageStart).toHaveBeenCalledWith(
      expect.any(Object),
      'implement',
      expect.any(Object),
      expect.any(String)
    );
    expect(mockSessionService.recordStageComplete).toHaveBeenCalledWith(expect.any(Object), 'implement', null);
  });
});
