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
    isRepoResolvable: jest.fn(() => true),
    scaffoldNewRepo: jest.fn((repo: string, baseDir: string) =>
      path.resolve(baseDir, '..', repo),
    ),
  };
});

// withRepoLock is exercised for real in repo-lock.spec.ts; mocked here as a passthrough so
// command specs don't take a real filesystem lock on the shared literal '/tmp/consumer-app'
// path, which could collide across parallel Jest workers.
jest.mock('../shared/utils/repo-lock', () => ({
  withRepoLock: jest.fn((_repoDir: string, fn: () => Promise<unknown>) => fn()),
}));

jest.mock('../shared/utils/resolve-ui-design-screenshots', () => ({
  resolveUiDesignScreenshots: jest.fn().mockReturnValue([]),
}));

jest.mock('../config/wf-config-loader', () => ({
  initializeWfConfig: jest.fn().mockResolvedValue({}),
  getLoadedWfConfig: jest.fn().mockReturnValue({ tracker: 'jira' }),
}));

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CommandMeta } from 'nest-commander/src/constants';
import { IssueCommand, shouldForkReviewSession, FORK_PASS_THRESHOLD } from './issue.command';
import { ReviewPresenter } from '../shared/presentation/review-presenter.service';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import { AiService } from '../integrations/ai/ai.service';
import type { PlanArtifact } from '../agents/interfaces';
import { SessionService } from '../shared/session/session.service';
import { buildPlanArtifactManifestPath, hashPlanArtifactSources } from '../shared/utils/plan-artifact';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inquirer from 'inquirer';
import { getWfHomeDir } from '../shared/utils/wf-paths';
import { createTempDir as createManagedTempDir } from '../shared/testing/temp-dir';
import { initializeWfConfig } from '../config/wf-config-loader';

const mockSessionService = {
  load: jest.fn().mockResolvedValue(null),
  save: jest.fn().mockResolvedValue(undefined),
  findByTicketKey: jest.fn().mockResolvedValue(null),
  recordStageStart: jest.fn().mockImplementation(session => Promise.resolve(session)),
  recordProviderSessionId: jest.fn().mockImplementation(session => Promise.resolve(session)),
  recordStageComplete: jest.fn().mockImplementation(session => Promise.resolve(session)),
  recordSourceBranch: jest.fn().mockImplementation((session, sourceBranch) =>
    Promise.resolve({ ...session, sourceBranch })),
  markComplete: jest.fn().mockImplementation(session => Promise.resolve(session)),
  inferNextStage: jest.fn().mockReturnValue('fetch'),
  validateForStage: jest
    .fn()
    .mockReturnValue({ canResume: false, resumableProviderSessionId: null, priorSummary: null, warnings: [] }),
  isExpired: jest.fn().mockReturnValue(false),
  getSessionDir: jest.fn().mockReturnValue('/tmp/sessions'),
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

const createMockSessionState = (overrides?: Record<string, unknown>) => ({
  sessionId: 'existing-uuid',
  ticketKey: 'WBP-100',
  toStage: 'review',
  action: 'fix',
  sourceType: 'ticket',
  customPlanRef: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  stages: {},
  ...overrides,
});

const resetMockSessionService = (): void => {
  mockSessionService.load.mockReset();
  mockSessionService.load.mockResolvedValue(null);
  mockSessionService.save.mockReset();
  mockSessionService.save.mockResolvedValue(undefined);
  mockSessionService.findByTicketKey.mockReset();
  mockSessionService.findByTicketKey.mockResolvedValue(null);
  mockSessionService.recordStageStart.mockReset();
  mockSessionService.recordStageStart.mockImplementation(session => Promise.resolve(session));
  mockSessionService.recordProviderSessionId.mockReset();
  mockSessionService.recordProviderSessionId.mockImplementation(session => Promise.resolve(session));
  mockSessionService.recordStageComplete.mockReset();
  mockSessionService.recordStageComplete.mockImplementation(session => Promise.resolve(session));
  mockSessionService.markComplete.mockReset();
  mockSessionService.markComplete.mockImplementation(session => Promise.resolve(session));
  mockSessionService.inferNextStage.mockReset();
  mockSessionService.inferNextStage.mockReturnValue('fetch');
  mockSessionService.validateForStage.mockReset();
  mockSessionService.validateForStage.mockReturnValue({
    canResume: false,
    resumableProviderSessionId: null,
    priorSummary: null,
    warnings: [],
  });
  mockSessionService.isExpired.mockReset();
  mockSessionService.isExpired.mockReturnValue(false);
  mockSessionService.getSessionDir.mockReset();
  mockSessionService.getSessionDir.mockReturnValue('/tmp/sessions');

  (inquirer.prompt as unknown as jest.Mock).mockReset();

  const agentsUtils = require('../agents/utils') as {
    resolveRepoBasePath: jest.Mock;
    isRepoResolvable: jest.Mock;
    scaffoldNewRepo: jest.Mock;
  };
  agentsUtils.resolveRepoBasePath.mockReset();
  agentsUtils.resolveRepoBasePath.mockImplementation((repo?: string) =>
    repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app'
  );
  agentsUtils.isRepoResolvable.mockReset();
  agentsUtils.isRepoResolvable.mockReturnValue(true);
  agentsUtils.scaffoldNewRepo.mockReset();
  agentsUtils.scaffoldNewRepo.mockImplementation((repo: string, baseDir: string) =>
    path.resolve(baseDir, '..', repo)
  );
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
          getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
        },
      },
      { provide: SessionService, useValue: mockSessionService },
      {
        provide: ReviewPresenter,
        useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
      },
    ],
  }).compile();

  return module.get(IssueCommand);
}

describe('IssueCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    resetMockSessionService();
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

  it('rejects plan-token together with --session-id', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['dark-plan.json'], {
      sessionId: 'existing-uuid',
      from: 'implement',
      action: 'fix',
      silent: true,
    } as any);

    expect(mockSessionService.load).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--session-id');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects --force together with --session-id', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {
      force: true,
      sessionId: 'some-uuid',
      from: 'implement',
      action: 'fix',
      silent: true,
    } as any);

    expect(mockSessionService.load).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--force');

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

  it('infers ticket workflow options from a loaded session when only --session-id is provided', async () => {
    const command = await buildCommand();
    const session = createMockSessionState({
      ticketKey: 'WBP-200',
      toStage: 'review',
      action: 'fix',
      sourceType: 'ticket',
      stages: {
        fetch: {
          config: { provider: 'openai', backend: 'cli' },
          model: 'gpt-5',
          providerSessionId: null,
          summary: 'fetched',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      },
    });
    mockSessionService.load.mockResolvedValueOnce(session);
    mockSessionService.inferNextStage.mockReturnValueOnce('plan');

    const ctx = await (command as any).validateAndResolveInputs([], { sessionId: 'existing-uuid', silent: true });

    expect(mockSessionService.load).toHaveBeenCalledWith('existing-uuid');
    expect(mockSessionService.inferNextStage).toHaveBeenCalledWith(session);
    expect(ctx.ticketKey).toBe('WBP-200');
    expect(ctx.action).toBe('fix');
    expect(ctx.fromStage).toBe('plan');
    expect(ctx.toStage).toBe('review');
    expect(ctx.options.ticketKey).toBe('WBP-200');
    expect(ctx.preloadedSession).toEqual(session);
  });

  it('prefers explicit CLI stage options over session defaults', async () => {
    const command = await buildCommand();
    mockSessionService.load.mockResolvedValueOnce(createMockSessionState({
      ticketKey: 'WBP-201',
      toStage: 'review',
      sourceType: 'ticket',
    }));
    mockSessionService.inferNextStage.mockReturnValueOnce('plan');

    const ctx = await (command as any).validateAndResolveInputs([], {
      sessionId: 'existing-uuid',
      to: 'commit',
      from: 'implement',
      ticketKey: 'WBP-201',
      silent: true,
    });

    expect(ctx.fromStage).toBe('implement');
    expect(ctx.toStage).toBe('commit');
    expect(ctx.options.to).toBe('commit');
    expect(ctx.options.from).toBe('implement');
  });

  it('infers custom plan workflow options from a loaded session', async () => {
    const command = await buildCommand();
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    const session = createMockSessionState({
      ticketKey: 'custom-plan',
      toStage: 'commit',
      action: 'fix',
      sourceType: 'custom',
      customPlanRef: 'plans/custom-plan.md',
    });
    mockSessionService.load.mockResolvedValueOnce(session);
    mockSessionService.inferNextStage.mockReturnValueOnce('plan');

    const ctx = await (command as any).validateAndResolveInputs([], { sessionId: 'existing-uuid', silent: true });

    expect(ctx.ticketKey).toBe('custom-plan');
    expect(ctx.customSourcePath).toContain('plans/custom-plan.md');
    expect(ctx.options.customPlan).toBe('plans/custom-plan.md');
    expect(ctx.fromStage).toBe('plan');
    existsSyncSpy.mockRestore();
  });

  it('merges legacy session defaults but still requires a known action', async () => {
    const command = await buildCommand();
    const legacySession = createMockSessionState({
      ticketKey: 'WBP-202',
      toStage: null,
      action: null,
      sourceType: null,
      customPlanRef: null,
    });
    mockSessionService.load.mockResolvedValue(legacySession);
    mockSessionService.inferNextStage.mockReturnValueOnce('fetch');

    const merged = await (command as any).loadAndMergeSessionDefaults({ sessionId: 'existing-uuid', silent: true });
    expect(merged.options.ticketKey).toBe('WBP-202');
    expect(merged.options.to).toBe('commit');

    await expect(
      (command as any).validateAndResolveInputs([], { sessionId: 'existing-uuid', silent: true })
    ).rejects.toThrow('--action is required when running PLAN stage');
  });

  it('prompts before clearing a missing session in interactive mode', async () => {
    const command = await buildCommand();
    mockSessionService.load.mockResolvedValueOnce(null);
    (inquirer.prompt as unknown as jest.Mock).mockResolvedValueOnce({ proceed: true });
    setInteractiveSession();

    const merged = await (command as any).loadAndMergeSessionDefaults({ sessionId: 'missing-uuid', silent: true });

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(merged.options.sessionId).toBeUndefined();
  });

  it('exits with the existing not-found error in non-interactive mode', async () => {
    const command = await buildCommand();
    mockSessionService.load.mockResolvedValueOnce(null);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], { sessionId: 'missing-uuid', silent: true } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'Session missing-uuid not found'
    );

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
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
    const expectedDir = path.join(getWfHomeDir(), 'consumer-app', 'jira');

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
    const expectedDir = path.join(getWfHomeDir(), 'repo-a', 'jira');

    expect(path.dirname(fetchPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('resolves a hashed plan token when resuming from implement without --action', async () => {
    const hash = hashPlanArtifactSources(['WBP-1']);
    const artifactDir = path.join(getWfHomeDir(), 'repo-a', 'jira');
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
            getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
          },
        },
        { provide: SessionService, useValue: mockSessionService },
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    expect(mockOrchestrator.planner.loadFromDisk).toHaveBeenCalledWith(ticketPath, undefined, undefined, path.join('/tmp/consumer-app', 'repo-a'));
    expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: 'WBP-1' }),
      expect.objectContaining({ action: 'fix', path: planPath }),
      expect.objectContaining({ trackerName: 'jira' }),
    );
  });

  it('resolves a plan token via direct file-path fallback when manifest-based resolution fails (no --repos)', async () => {
    const hash = hashPlanArtifactSources(['WBP-2']);
    const artifactDir = path.join(getWfHomeDir(), 'consumer-app', 'jira');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const artifactDir = path.join(getWfHomeDir(), 'target-repo', 'jira');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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

    expect(mockSessionService.save.mock.calls[0][0]).toEqual(expect.objectContaining({ sourceType: 'custom' }));
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
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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

  it('copies the plan manifest\'s recorded sourceBranch onto the session after the implement stage', async () => {
    const hash = hashPlanArtifactSources(['WBP-7']);
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
    const planFilename = `2026-06-30-${hash}-fix-plan.json`;
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    const mockImplementerExecute = jest.fn().mockResolvedValue({
      type: 'implementation', hasChanges: true, branchName: 'feature/WBP-7', verificationOutcomes: [],
    });
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
          sourceBranch: 'release/2026',
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

    mockSessionService.validateForStage.mockReturnValue({
      canResume: true,
      resumableProviderSessionId: 'sess-plan-123',
      priorSummary: 'Plan summary from prior stage',
      warnings: [],
    });

    await command.run([planFilename], { from: 'implement', to: 'implement' });

    expect(mockSessionService.recordSourceBranch).toHaveBeenCalledWith(expect.any(Object), 'release/2026');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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

    const { withRepoLock } = jest.requireMock('../shared/utils/repo-lock');
    expect(withRepoLock).toHaveBeenCalledWith('/tmp/consumer-app', expect.any(Function));
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const ticketPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-20.md');
    const planPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-20-fix-plan.json');

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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const ticketPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-21.md');
    const planPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-21-fix-plan.json');

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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const ticketPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-22.md');
    const planPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-22-fix-plan.json');
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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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

    await command.run([], { from: 'plan', to: 'plan', action: 'fix', sessionId: 'existing-uuid' });

    expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'existing-uuid' }),
      'plan',
      'sess-resume-789',
    );
  });

  it('skips provider session ID prompt in non-interactive session when plan is from cache', async () => {
    const ticketPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-23.md');
    const planPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-23-fix-plan.json');

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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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
    const ticketPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-24.md');
    const planPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'WBP-24-fix-plan.json');

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
        {
          provide: ReviewPresenter,
          useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
        },
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

  describe('review stage skip on empty implement', () => {
    const planHash = hashPlanArtifactSources(['WBP-SKIP']);
    const planFilename = `2026-07-22-${planHash}-fix-plan.json`;
    const customDir = path.join(getWfHomeDir(), 'consumer-app');
    const planPath = path.join(customDir, planFilename);
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    const planJson = JSON.stringify({
      action: 'fix',
      summary: 'Test plan',
      estimatedComplexity: 'low',
      steps: ['Step 1'],
      affectedFiles: ['src/test.ts'],
      affectedRepositories: [],
    });

    const manifestJson = JSON.stringify({
      artifactPath: planPath,
      action: 'fix',
      createdAt: new Date('2026-07-22T00:00:00.000Z').toISOString(),
      format: 'json',
      hash: planHash,
      sourceKind: 'custom',
      sourceName: 'WBP-SKIP',
    });

    const buildTestCommand = async (mockOrchestrator: Record<string, unknown>): Promise<IssueCommand> => {
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
          {
            provide: ReviewPresenter,
            useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
          },
        ],
      }).compile();
      return module.get(IssueCommand);
    };

    const stubFs = (): void => {
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([] as any);
      jest.spyOn(require('fs'), 'existsSync').mockImplementation(
        (input: string) => String(input) === planPath || String(input) === manifestPath,
      );
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const p = String(input);
        if (p === manifestPath) return manifestJson;
        if (p === planPath) return planJson;
        return '';
      });
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('skips review and logs when implementerResult.hasChanges is false', async () => {
      const mockReviewerExecute = jest.fn();
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest',
            path: path.join('/tmp/consumer-app', 'jira', 'WBP-SKIP.md'),
          }),
        },
        implementer: {
          execute: jest.fn().mockResolvedValue({
            type: 'implementation', hasChanges: false, branchName: null,
            sessionId: undefined, verificationOutcomes: [],
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() },
      };

      const command = await buildTestCommand(mockOrchestrator);
      stubFs();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([planFilename], { from: 'implement', to: 'review' });

      expect(mockReviewerExecute).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
      expect(logCalls.some(msg => msg.includes('Skipping review'))).toBe(true);
    });

    it('runs review normally when implementerResult.hasChanges is true', async () => {
      const mockReviewerExecute = jest.fn().mockResolvedValue(null);
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest',
            path: path.join('/tmp/consumer-app', 'jira', 'WBP-SKIP.md'),
          }),
        },
        planner: {
          loadFromDisk: jest.fn().mockReturnValue({
            action: 'fix',
            path: planPath,
            plan: JSON.parse(planJson),
          }),
        },
        implementer: {
          execute: jest.fn().mockResolvedValue({
            type: 'implementation', hasChanges: true, branchName: null,
            sessionId: undefined, verificationOutcomes: [],
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() },
      };

      const command = await buildTestCommand(mockOrchestrator);
      stubFs();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([planFilename], { from: 'implement', to: 'review' });

      expect(mockReviewerExecute).toHaveBeenCalled();
    });

    it('runs review normally when implementerResult is undefined (standalone review)', async () => {
      const mockReviewerExecute = jest.fn().mockResolvedValue(null);
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest',
            path: path.join('/tmp/consumer-app', 'jira', 'WBP-SKIP.md'),
          }),
        },
        planner: {
          loadFromDisk: jest.fn().mockReturnValue({
            action: 'fix',
            path: planPath,
            plan: JSON.parse(planJson),
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() },
      };

      const command = await buildTestCommand(mockOrchestrator);
      stubFs();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([planFilename], { from: 'review', to: 'review' });

      expect(mockReviewerExecute).toHaveBeenCalled();
    });

    it('records review provider session ID when review artifact carries one', async () => {
      const mockReviewerExecute = jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
        path: '/tmp/review.md',
        approved: true,
        sessionId: 'review-sess-abc',
      });
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest',
            path: path.join('/tmp/consumer-app', 'jira', 'WBP-SKIP.md'),
          }),
        },
        implementer: {
          execute: jest.fn().mockResolvedValue({
            type: 'implementation', hasChanges: true, branchName: null,
            sessionId: undefined, verificationOutcomes: [],
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() },
      };

      const command = await buildTestCommand(mockOrchestrator);
      stubFs();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([planFilename], { from: 'implement', to: 'review' });

      expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(
        expect.any(Object), 'review', 'review-sess-abc',
      );
    });

    it('continues multi-repo review after one repo fails and keeps the last successful artifact', async () => {
      const mockReviewerExecute = jest.fn()
        .mockRejectedValueOnce(new Error('repo 1 failed'))
        .mockResolvedValueOnce({
          review: { summary: 'ok', issues: [], suggestions: [], approved: true },
          path: '/tmp/review-2.md',
          approved: true,
          sessionId: 'review-sess-2',
        });
      const mockPersistArtifact = jest.fn();
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest',
            path: path.join('/tmp/consumer-app', 'jira', 'WBP-SKIP.md'),
          }),
        },
        implementer: {
          execute: jest.fn().mockResolvedValue({
            type: 'implementation', hasChanges: true, branchName: null,
            sessionId: undefined, verificationOutcomes: [],
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: mockPersistArtifact },
      };

      const command = await buildTestCommand(mockOrchestrator);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const result = await (command as any).runReviewLoop(
        { ticketKey: 'WBP-SKIP', content: '# WBP-SKIP\n\nTest', path: '/tmp/consumer-app/jira/WBP-SKIP.md' },
        { plan: { estimatedComplexity: 'high' } },
        ['repo-1', 'repo-2'],
        {},
        { resumeProviderSessionId: 'review-sess-1', forkSession: true },
        'WBP-SKIP'
      );

      expect(result).toEqual(expect.objectContaining({ path: '/tmp/review-2.md', sessionId: 'review-sess-2' }));
      expect(mockReviewerExecute).toHaveBeenCalledTimes(2);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review failed for repo-1'));
      expect(mockPersistArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/review-2.md' }), 'WBP-SKIP');
    });

    it('forwards --sonar flag to reviewer.execute', async () => {
      const mockReviewerExecute = jest.fn().mockResolvedValue(null);
      const mockOrchestrator = {
        fetcher: {
          loadFromDisk: jest.fn().mockReturnValue({
            ticketKey: 'WBP-123', content: '# WBP-123\n\nTest',
            path: '/tmp/consumer-app/jira/WBP-123.md',
          }),
        },
        reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() },
      };

      const command = await buildTestCommand(mockOrchestrator);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await (command as any).runReviewForRepo(undefined, {
        isMultiRepo: false,
        options: { sonar: true },
        planArtifact: undefined,
        repos: [undefined],
        sessionContext: {},
        ticketArtifact: { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/consumer-app/jira/WBP-123.md' },
      });

      expect(mockReviewerExecute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sonar: true })
      );
    });
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
      const tempDir = createManagedTempDir('custom-token');
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
      const tempDir = createManagedTempDir('custom-token');
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
      const tempDir = createManagedTempDir('custom-token');
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
      const tempDir = createManagedTempDir('custom-token');
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

  describe('buildImplementerOptions figma forwarding', () => {
    it('includes figma from IssueOptions in the returned options', async () => {
      const command = await buildCommand();
      const opts = (command as any).buildImplementerOptions(
        'repo', ['repo'], { tracker: 'jira', figma: true }, false, {}
      );
      expect(opts).toHaveProperty('figma', true);
    });
  });

  describe('assertBranchNamePatternFlag', () => {
    it('throws a clear error when --branch-name-pattern is an invalid regex', async () => {
      const command = await buildCommand();
      expect(() => (command as any).assertBranchNamePatternFlag('[')).toThrow(
        '--branch-name-pattern is not a valid regular expression: ['
      );
    });

    it('accepts a valid pattern and an absent flag', async () => {
      const command = await buildCommand();
      expect(() => (command as any).assertBranchNamePatternFlag('^team\\/[a-z-]+$')).not.toThrow();
      expect(() => (command as any).assertBranchNamePatternFlag(undefined)).not.toThrow();
    });
  });

  describe('assertMutualExclusions uiDesignScreenshots', () => {
    it('throws when --figma and --ui-design-screenshots both provided', async () => {
      const command = await buildCommand();
      expect(() =>
        (command as any).assertMutualExclusions(undefined, {
          ticketKey: 'WBP-1', figma: true, uiDesignScreenshots: ['design.png'],
        })
      ).toThrow('mutually exclusive');
    });

    it('does not throw when only --ui-design-screenshots provided', async () => {
      const command = await buildCommand();
      expect(() =>
        (command as any).assertMutualExclusions(undefined, {
          ticketKey: 'WBP-1', uiDesignScreenshots: ['design.png'],
        })
      ).not.toThrow();
    });
  });

  describe('buildImplementerOptions isNewRepo', () => {
    it('sets isNewRepo when repo is in plan newRepositories', async () => {
      const command = await buildCommand();
      const planArtifact: PlanArtifact = {
        action: 'fix',
        path: '/tmp/.wf/consumer-app/jira/plan.json',
        plan: {
          action: 'fix',
          summary: 'Test',
          steps: [],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: ['new-lib'],
          newRepositories: ['new-lib'],
        },
      };

      const opts = (command as any).buildImplementerOptions(
        'new-lib', ['new-lib'], { tracker: 'jira' }, false, {}, planArtifact
      );

      expect(opts.isNewRepo).toBe(true);
    });

    it('does not set isNewRepo for repos absent from newRepositories', async () => {
      const command = await buildCommand();
      const planArtifact: PlanArtifact = {
        action: 'fix',
        path: '/tmp/.wf/consumer-app/jira/plan.json',
        plan: {
          action: 'fix',
          summary: 'Test',
          steps: [],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: ['existing-repo'],
          newRepositories: ['other-repo'],
        },
      };

      const opts = (command as any).buildImplementerOptions(
        'existing-repo', ['existing-repo'], { tracker: 'jira' }, false, {}, planArtifact
      );

      expect(opts.isNewRepo).toBe(false);
    });
  });

  describe('expandReposFromPlan', () => {
    const buildExpandPlanArtifact = (
      affectedRepositories: string[], newRepositories?: string[]
    ): PlanArtifact => ({
      action: 'fix',
      path: '/tmp/.wf/consumer-app/jira/plan.md',
      plan: {
        action: 'fix',
        summary: 'Extract contracts',
        steps: [],
        estimatedComplexity: 'high',
        affectedFiles: [],
        affectedRepositories,
        newRepositories,
      },
    });

    it('scaffolds repos declared in newRepositories and prepends them', async () => {
      const { isRepoResolvable, scaffoldNewRepo } = jest.requireMock('../agents/utils');
      isRepoResolvable.mockImplementation((repo: string) => repo !== 'new-contracts');

      const command = await buildCommand();
      const expanded = await (command as any).expandReposFromPlan(
        [undefined],
        buildExpandPlanArtifact(['consumer-app', 'new-contracts'], ['new-contracts']),
        '/tmp/consumer-app', false
      );

      expect(scaffoldNewRepo).toHaveBeenCalledWith('new-contracts', '/tmp/consumer-app');
      expect(expanded).toEqual(['new-contracts', undefined]);
    });

    it('throws when unresolvable repos are not declared in newRepositories', async () => {
      const { isRepoResolvable } = jest.requireMock('../agents/utils');
      isRepoResolvable.mockImplementation((repo: string) => repo !== 'typo-repo');

      const command = await buildCommand();

      await expect((command as any).expandReposFromPlan(
        [undefined],
        buildExpandPlanArtifact(['consumer-app', 'typo-repo']),
        '/tmp/consumer-app', false
      )).rejects.toThrow('Plan references repositories not found locally: typo-repo');
    });

    it('returns repos unchanged when all plan repos are resolvable', async () => {
      const { isRepoResolvable, scaffoldNewRepo } = jest.requireMock('../agents/utils');
      isRepoResolvable.mockReturnValue(true);

      const command = await buildCommand();
      const expanded = await (command as any).expandReposFromPlan(
        [undefined],
        buildExpandPlanArtifact(['consumer-app', 'existing-repo']),
        '/tmp/consumer-app', false
      );

      expect(scaffoldNewRepo).not.toHaveBeenCalled();
      expect(expanded).toEqual([undefined]);
    });

    it('skips scaffolding for newRepositories that already exist locally', async () => {
      const { isRepoResolvable, scaffoldNewRepo } = jest.requireMock('../agents/utils');
      isRepoResolvable.mockReturnValue(true);

      const command = await buildCommand();
      const expanded = await (command as any).expandReposFromPlan(
        [undefined],
        buildExpandPlanArtifact(['consumer-app', 'already-exists'], ['already-exists']),
        '/tmp/consumer-app', false
      );

      expect(scaffoldNewRepo).not.toHaveBeenCalled();
      expect(expanded).toEqual([undefined]);
    });

    describe('interactive mode', () => {
      const originalStdinIsTTY = process.stdin.isTTY;
      const originalStdoutIsTTY = process.stdout.isTTY;

      afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
        jest.restoreAllMocks();
      });

      it('prompts user to manually create directory and config', async () => {
        const { isRepoResolvable, scaffoldNewRepo } = jest.requireMock('../agents/utils');
        isRepoResolvable.mockImplementation((repo: string) => repo !== 'new-contracts');
        const inquirer = jest.requireMock('inquirer').default;
        inquirer.prompt.mockResolvedValue({ ready: true });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

        const existsSync = jest.spyOn(require('node:fs'), 'existsSync');
        existsSync.mockImplementation((path: string) => {
          if (path === '/tmp/new-contracts') return true;
          if (path.startsWith('/tmp/new-contracts/wf.config')) return true;
          return false;
        });

        const command = await buildCommand();
        const expanded = await (command as any).expandReposFromPlan(
          [undefined],
          buildExpandPlanArtifact(['consumer-app', 'new-contracts'], ['new-contracts']),
          '/tmp/consumer-app', false
        );

        expect(scaffoldNewRepo).not.toHaveBeenCalled();
        expect(expanded).toEqual(['new-contracts', undefined]);
      });

      it('throws ValidationError when user confirms but directory is missing', async () => {
        const { isRepoResolvable } = jest.requireMock('../agents/utils');
        isRepoResolvable.mockImplementation((repo: string) => repo !== 'new-contracts');
        const inquirer = jest.requireMock('inquirer').default;
        inquirer.prompt.mockResolvedValue({ ready: true });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

        const existsSync = jest.spyOn(require('node:fs'), 'existsSync');
        existsSync.mockReturnValue(false);

        const command = await buildCommand();

        await expect((command as any).expandReposFromPlan(
          [undefined],
          buildExpandPlanArtifact(['consumer-app', 'new-contracts'], ['new-contracts']),
          '/tmp/consumer-app', false
        )).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('directory not found') }));
      });

      it('throws ValidationError when user confirms but wf.config.* is missing', async () => {
        const { isRepoResolvable } = jest.requireMock('../agents/utils');
        isRepoResolvable.mockImplementation((repo: string) => repo !== 'new-contracts');
        const inquirer = jest.requireMock('inquirer').default;
        inquirer.prompt.mockResolvedValue({ ready: true });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

        const existsSync = jest.spyOn(require('node:fs'), 'existsSync');
        existsSync.mockImplementation((path: string) => {
          if (path === '/tmp/new-contracts') return true;
          if (path.startsWith('/tmp/new-contracts/wf.config')) return false;
          return false;
        });

        const command = await buildCommand();

        await expect((command as any).expandReposFromPlan(
          [undefined],
          buildExpandPlanArtifact(['consumer-app', 'new-contracts'], ['new-contracts']),
          '/tmp/consumer-app', false
        )).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('wf.config.* not found') }));
      });

      it('returns original repos when user declines confirmation', async () => {
        const { isRepoResolvable, scaffoldNewRepo } = jest.requireMock('../agents/utils');
        isRepoResolvable.mockImplementation((repo: string) => repo !== 'new-contracts');
        const inquirer = jest.requireMock('inquirer').default;
        inquirer.prompt.mockResolvedValue({ ready: false });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

        const command = await buildCommand();
        const expanded = await (command as any).expandReposFromPlan(
          [undefined],
          buildExpandPlanArtifact(['consumer-app', 'new-contracts'], ['new-contracts']),
          '/tmp/consumer-app', false
        );

        expect(scaffoldNewRepo).not.toHaveBeenCalled();
        expect(expanded).toEqual([undefined]);
      });
    });
  });

  describe('runImplementLoop hasChanges accumulation', () => {
    const mockTicketArtifact: any = {
      ticketKey: 'WBP-ACC',
      content: '# WBP-ACC\n\nTest',
      path: '/tmp/.wf/consumer-app/jira/WBP-ACC.md',
    };

    const mockPlanArtifact: any = {
      action: 'fix',
      path: '/tmp/.wf/consumer-app/jira/WBP-ACC-plan.json',
      plan: {
        action: 'fix',
        summary: 'Test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [],
        affectedRepositories: ['repoA', 'repoB'],
      },
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns hasChanges true when first repo has changes but last does not', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn()
        .mockResolvedValueOnce({ type: 'implementation', hasChanges: true, branchName: null, sessionId: undefined, verificationOutcomes: [] })
        .mockResolvedValueOnce({ type: 'implementation', hasChanges: false, branchName: null, sessionId: undefined, verificationOutcomes: [] });
      (command as any).agents = { implementer: { execute: executeMock } };

      const result = await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, {}, 'repoA'
      );

      expect(result.implementerResult.hasChanges).toBe(true);
    });

    it('returns hasChanges false when no repo has changes', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn()
        .mockResolvedValue({ type: 'implementation', hasChanges: false, branchName: null, sessionId: undefined, verificationOutcomes: [] });
      (command as any).agents = { implementer: { execute: executeMock } };

      const result = await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, {}, 'repoA'
      );

      expect(result.implementerResult.hasChanges).toBe(false);
    });

    it('returns hasChanges true when last repo has changes and first does not', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn()
        .mockResolvedValueOnce({ type: 'implementation', hasChanges: false, branchName: null, sessionId: undefined, verificationOutcomes: [] })
        .mockResolvedValueOnce({ type: 'implementation', hasChanges: true, branchName: null, sessionId: undefined, verificationOutcomes: [] });
      (command as any).agents = { implementer: { execute: executeMock } };

      const result = await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, {}, 'repoA'
      );

      expect(result.implementerResult.hasChanges).toBe(true);
    });
  });

  describe('runWorkflowStages repo propagation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes expandedRepos from implement stage to review stage', async () => {
      const command = await buildCommand();
      jest.spyOn(command as any, 'executeImplementStage').mockResolvedValue({
        implementerResult: { type: 'implementation', hasChanges: true, branchName: null, sessionId: undefined, verificationOutcomes: [] },
        sessionState: { id: 'mock-session' } as any,
        earlyReturn: false,
        expandedRepos: ['repoA', 'newRepo'],
      });
      const reviewSpy = jest.spyOn(command as any, 'executeReviewStage').mockResolvedValue({ sessionState: undefined });
      jest.spyOn(command as any, 'executeCommitStage').mockResolvedValue(undefined);

      const ctx: any = {
        stagesToRun: ['implement', 'review', 'commit'],
        options: { silent: true },
        repos: ['repoA'],
        ticketKey: 'WBP-PROP',
      };
      const planArtifact: any = {
        action: 'fix',
        plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
      };

      await (command as any).runWorkflowStages(ctx, { ticketArtifact: {} as any, planArtifact }, undefined);

      expect(reviewSpy).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), ['repoA', 'newRepo'], expect.anything(), expect.anything(), expect.anything(),
        expect.objectContaining({ primaryRepo: 'repoA' })
      );
    });

    it('passes expandedRepos from implement stage to commit stage', async () => {
      const command = await buildCommand();
      jest.spyOn(command as any, 'executeImplementStage').mockResolvedValue({
        implementerResult: { type: 'implementation', hasChanges: true, branchName: null, sessionId: undefined, verificationOutcomes: [] },
        sessionState: undefined,
        earlyReturn: false,
        expandedRepos: ['repoA', 'newRepo'],
      });
      jest.spyOn(command as any, 'executeReviewStage').mockResolvedValue({ sessionState: undefined });
      const commitSpy = jest.spyOn(command as any, 'executeCommitStage').mockResolvedValue(undefined);

      const ctx: any = {
        stagesToRun: ['implement', 'review', 'commit'],
        options: { silent: true },
        repos: ['repoA'],
        ticketKey: 'WBP-PROP',
        trackerName: 'jira',
      };
      const planArtifact: any = {
        action: 'fix',
        plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
      };

      await (command as any).runWorkflowStages(ctx, { ticketArtifact: {} as any, planArtifact }, undefined);

      expect(commitSpy).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), ['repoA', 'newRepo'], expect.anything(), expect.anything()
      );
    });
  });

  describe('shouldForkReviewSession', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns true when estimatedComplexity is high and a session exists', () => {
      expect(shouldForkReviewSession('high', undefined, 'session-123')).toBe(true);
    });

    it('returns true when passCount exceeds FORK_PASS_THRESHOLD and a session exists', () => {
      expect(shouldForkReviewSession('medium', FORK_PASS_THRESHOLD + 1, 'session-123')).toBe(true);
    });

    it('returns false when passCount equals FORK_PASS_THRESHOLD (not strictly greater)', () => {
      expect(shouldForkReviewSession('medium', FORK_PASS_THRESHOLD, 'session-123')).toBe(false);
    });

    it('returns false when passCount is below FORK_PASS_THRESHOLD', () => {
      expect(shouldForkReviewSession('medium', 3, 'session-123')).toBe(false);
    });

    it('returns false when complexity is low and passCount is undefined', () => {
      expect(shouldForkReviewSession('low', undefined, 'session-123')).toBe(false);
    });

    it('returns false when resumeSessionId is undefined regardless of complexity', () => {
      expect(shouldForkReviewSession('high', undefined, undefined)).toBe(false);
    });

    it('returns true at the passCount boundary one above threshold', () => {
      expect(shouldForkReviewSession('medium', 6, 'session-123')).toBe(true);
    });
  });

  describe('scopeSessionContextToRepo', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns context unchanged when resumeProviderSessionId is absent', async () => {
      const command = await buildCommand();
      const ctx = { priorStageSummary: 'summary' };
      const result = (command as any).scopeSessionContextToRepo(ctx, 'repoA', 'repoA');
      expect(result).toBe(ctx);
    });

    it('returns context with resumeProviderSessionId when repo matches primaryRepo', async () => {
      const command = await buildCommand();
      const ctx = { resumeProviderSessionId: 'sid-123', priorStageSummary: 'summary' };
      const result = (command as any).scopeSessionContextToRepo(ctx, 'repoA', 'repoA');
      expect(result.resumeProviderSessionId).toBe('sid-123');
      expect(result.priorStageSummary).toBe('summary');
    });

    it('clears resumeProviderSessionId while preserving other fields when repo differs from primaryRepo', async () => {
      const command = await buildCommand();
      const ctx = { resumeProviderSessionId: 'sid-123', priorStageSummary: 'summary' };
      const result = (command as any).scopeSessionContextToRepo(ctx, 'repoB', 'repoA');
      expect(result.resumeProviderSessionId).toBeUndefined();
      expect(result.priorStageSummary).toBe('summary');
      expect(result).not.toBe(ctx);
    });

    it('treats repo and primaryRepo both undefined as equal', async () => {
      const command = await buildCommand();
      const ctx = { resumeProviderSessionId: 'sid-123' };
      const result = (command as any).scopeSessionContextToRepo(ctx, undefined, undefined);
      expect(result.resumeProviderSessionId).toBe('sid-123');
    });
  });

  describe('runImplementLoop multi-repo session scoping', () => {
    const mockTicketArtifact: any = {
      ticketKey: 'WBP-SCOPE',
      content: '# WBP-SCOPE',
      path: '/tmp/.wf/consumer-app/jira/WBP-SCOPE.md',
    };

    const mockPlanArtifact: any = {
      action: 'fix',
      path: '/tmp/.wf/consumer-app/jira/WBP-SCOPE-plan.json',
      plan: {
        action: 'fix',
        summary: 'Test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [],
        affectedRepositories: ['repoA', 'repoB'],
      },
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes resumeProviderSessionId only to the primary repo implementer call', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn().mockResolvedValue({
        type: 'implementation', hasChanges: true, branchName: null,
        sessionId: 'primary-sid', verificationOutcomes: [],
      });
      (command as any).agents = { implementer: { execute: executeMock } };
      const sessionCtx = { resumeProviderSessionId: 'plan-sid', priorStageSummary: 'summary' };

      await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, sessionCtx, 'repoA'
      );

      expect(executeMock.mock.calls[0][2].resumeProviderSessionId).toBe('plan-sid');
      expect(executeMock.mock.calls[1][2].resumeProviderSessionId).toBeUndefined();
      expect(executeMock.mock.calls[1][2].priorStageSummary).toBe('summary');
    });

    it('returns primaryRepoSessionId from primary repo result', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn()
        .mockResolvedValueOnce({
          type: 'implementation', hasChanges: true, branchName: null,
          sessionId: 'primary-sid', verificationOutcomes: [],
        })
        .mockResolvedValueOnce({
          type: 'implementation', hasChanges: false, branchName: null,
          sessionId: 'secondary-sid', verificationOutcomes: [],
        });
      (command as any).agents = { implementer: { execute: executeMock } };

      const result = await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, {}, 'repoA'
      );

      expect(result.primaryRepoSessionId).toBe('primary-sid');
    });

    it('carries primaryRepoSessionId through early-return path', async () => {
      const command = await buildCommand();
      const executeMock = jest.fn()
        .mockResolvedValueOnce({
          type: 'implementation', hasChanges: true, branchName: null,
          sessionId: 'primary-sid', verificationOutcomes: [],
        })
        .mockResolvedValueOnce({ type: 'investigation', artifact: {} });
      (command as any).agents = { implementer: { execute: executeMock } };

      const result = await (command as any).runImplementLoop(
        mockTicketArtifact, mockPlanArtifact, ['repoA', 'repoB'], { silent: true }, {}, 'repoA'
      );

      expect(result.earlyReturn).toBe(true);
      expect(result.primaryRepoSessionId).toBe('primary-sid');
    });
  });

  describe('finalizeImplementSession primaryRepoSessionId', () => {
    const mockPlanArtifact: any = {
      action: 'fix',
      path: '/tmp/.wf/consumer-app/jira/WBP-FIN-plan.json',
      plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('persists primaryRepoSessionId when provided instead of result.sessionId', async () => {
      const command = await buildCommand();
      jest.spyOn(command as any, 'recordSessionSourceBranch').mockResolvedValue({});
      const sessionState: any = { stages: { implement: {} } };
      const lastRepoResult: any = {
        type: 'implementation', hasChanges: true, branchName: null,
        sessionId: 'last-repo-sid', verificationOutcomes: [],
      };

      await (command as any).finalizeImplementSession(sessionState, lastRepoResult, mockPlanArtifact, 'primary-sid');

      expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(sessionState, 'implement', 'primary-sid');
    });

    it('falls back to result.sessionId when primaryRepoSessionId is undefined', async () => {
      const command = await buildCommand();
      jest.spyOn(command as any, 'recordSessionSourceBranch').mockResolvedValue({});
      const sessionState: any = { stages: { implement: {} } };
      const result: any = {
        type: 'implementation', hasChanges: true, branchName: null,
        sessionId: 'fallback-sid', verificationOutcomes: [],
      };

      await (command as any).finalizeImplementSession(sessionState, result, mockPlanArtifact, undefined);

      expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(sessionState, 'implement', 'fallback-sid');
    });

    it('persists primaryRepoSessionId even when merged result is undefined', async () => {
      const command = await buildCommand();
      const sessionState: any = { stages: { implement: {} } };

      await (command as any).finalizeImplementSession(sessionState, undefined, mockPlanArtifact, 'primary-sid');

      expect(mockSessionService.recordProviderSessionId).toHaveBeenCalledWith(sessionState, 'implement', 'primary-sid');
    });
  });

  describe('runReviewForRepo multi-repo session scoping', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes resumeProviderSessionId to primary repo reviewer call', async () => {
      const command = await buildCommand();
      const mockReviewerExecute = jest.fn().mockResolvedValue(null);
      (command as any).agents = { reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() } };

      await (command as any).runReviewForRepo('repoA', {
        isMultiRepo: true,
        options: { silent: true },
        planArtifact: undefined,
        repos: ['repoA', 'repoB'],
        sessionContext: { resumeProviderSessionId: 'plan-sid', priorStageSummary: 'summary' },
        ticketArtifact: { ticketKey: 'WBP-1', content: '#WBP-1', path: '/tmp/jira/WBP-1.md' },
        ticketKey: 'WBP-1',
        primaryRepo: 'repoA',
      });

      expect(mockReviewerExecute.mock.calls[0][1].resumeProviderSessionId).toBe('plan-sid');
    });

    it('clears resumeProviderSessionId for non-primary repo reviewer call', async () => {
      const command = await buildCommand();
      const mockReviewerExecute = jest.fn().mockResolvedValue(null);
      (command as any).agents = { reviewer: { execute: mockReviewerExecute, persistArtifact: jest.fn() } };

      await (command as any).runReviewForRepo('repoB', {
        isMultiRepo: true,
        options: { silent: true },
        planArtifact: undefined,
        repos: ['repoA', 'repoB'],
        sessionContext: { resumeProviderSessionId: 'plan-sid', priorStageSummary: 'summary' },
        ticketArtifact: { ticketKey: 'WBP-1', content: '#WBP-1', path: '/tmp/jira/WBP-1.md' },
        ticketKey: 'WBP-1',
        primaryRepo: 'repoA',
      });

      expect(mockReviewerExecute.mock.calls[0][1].resumeProviderSessionId).toBeUndefined();
      expect(mockReviewerExecute.mock.calls[0][1].priorStageSummary).toBe('summary');
    });

    it('primaryRepo captured before expandReposFromPlan is passed to executeReviewStage', async () => {
      const command = await buildCommand();
      jest.spyOn(command as any, 'executeImplementStage').mockResolvedValue({
        implementerResult: { type: 'implementation', hasChanges: true, branchName: null, sessionId: undefined, verificationOutcomes: [] },
        sessionState: undefined,
        earlyReturn: false,
        expandedRepos: ['newRepo', 'repoA'],
        primaryRepoSessionId: undefined,
      });
      const reviewSpy = jest.spyOn(command as any, 'executeReviewStage').mockResolvedValue({ sessionState: undefined });
      jest.spyOn(command as any, 'executeCommitStage').mockResolvedValue(undefined);

      const ctx: any = {
        stagesToRun: ['implement', 'review'],
        options: { silent: true },
        repos: ['repoA'],
        ticketKey: 'WBP-EXPAND',
      };
      const planArtifact: any = {
        action: 'fix',
        plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
      };

      await (command as any).runWorkflowStages(ctx, { ticketArtifact: {} as any, planArtifact }, undefined);

      expect(reviewSpy.mock.calls[0][6]).toEqual(expect.objectContaining({ primaryRepo: 'repoA' }));
    });
  });

  describe('initializeWfConfig per-repo calls', () => {
    const buildLoopTestCommand = async (): Promise<IssueCommand> => {
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
            useValue: { get: jest.fn((key: string, defaultValue?: string) => key === 'tracker' ? 'jira' : defaultValue) },
          },
          {
            provide: DryRunPreviewService,
            useValue: {
              showHeader: jest.fn(), showStageHeader: jest.fn(), showSummary: jest.fn(),
              showValidationResult: jest.fn(), showSkipped: jest.fn(), showNoSideEffects: jest.fn(),
              previewApiCall: jest.fn(), previewFileRead: jest.fn(), previewFileWrite: jest.fn(),
            },
          },
          {
            provide: AgentOrchestrator,
            useValue: {
              implementer: { execute: jest.fn().mockResolvedValue({ type: 'implementation', hasChanges: false, sessionId: undefined, branchName: null, verificationOutcomes: [] }) },
              reviewer: { execute: jest.fn().mockResolvedValue(null), persistArtifact: jest.fn() },
              committer: { execute: jest.fn().mockResolvedValue(undefined) },
            },
          },
          { provide: AiService, useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'), getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions') } },
          { provide: SessionService, useValue: mockSessionService },
          {
            provide: ReviewPresenter,
            useValue: { displayReview: jest.fn(), formatTraceSectionNotes: jest.fn().mockReturnValue([]) },
          },
        ],
      }).compile();
      return module.get(IssueCommand);
    };

    beforeEach(() => {
      (initializeWfConfig as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('calls initializeWfConfig once per repo in runImplementLoop', async () => {
      const command = await buildLoopTestCommand();
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(command as any, 'executeRepoImplementation').mockResolvedValue({
        earlyReturn: false,
        implementerResult: { type: 'implementation', hasChanges: false, sessionId: undefined, branchName: null, verificationOutcomes: [] },
      });

      await (command as any).runImplementLoop(
        { ticketKey: 'WBP-123', content: '#', path: '/tmp/consumer-app/jira/WBP-123.md' },
        { action: 'fix', plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] }, path: '/tmp/plan.json' },
        ['repo-a', 'repo-b'],
        { silent: true },
        {},
        'repo-a'
      );

      expect(initializeWfConfig).toHaveBeenCalledTimes(2);
      expect(initializeWfConfig).toHaveBeenNthCalledWith(1, '/tmp/consumer-app/repo-a');
      expect(initializeWfConfig).toHaveBeenNthCalledWith(2, '/tmp/consumer-app/repo-b');
    });

    it('calls initializeWfConfig with the resolved repo path in runReviewForRepo', async () => {
      const command = await buildLoopTestCommand();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await (command as any).runReviewForRepo('repo-a', {
        isMultiRepo: true,
        options: {},
        planArtifact: undefined,
        repos: ['repo-a'],
        sessionContext: {},
        ticketArtifact: { ticketKey: 'WBP-TEST', content: '#', path: '/tmp/consumer-app/jira/WBP-TEST.md' },
      });

      expect(initializeWfConfig).toHaveBeenCalledWith('/tmp/consumer-app/repo-a');
    });

    it('calls initializeWfConfig once per repo in executeCommitStage', async () => {
      const command = await buildLoopTestCommand();
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await (command as any).executeCommitStage('WBP-123', undefined, ['repo-a', 'repo-b'], { silent: true }, 'jira');

      expect(initializeWfConfig).toHaveBeenCalledTimes(2);
      expect(initializeWfConfig).toHaveBeenNthCalledWith(1, '/tmp/consumer-app/repo-a');
      expect(initializeWfConfig).toHaveBeenNthCalledWith(2, '/tmp/consumer-app/repo-b');
    });
  });
});
