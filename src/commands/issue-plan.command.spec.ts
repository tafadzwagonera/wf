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

jest.mock('../common/utils/ensure-wf-home', () => ({
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

jest.mock('../common/utils/plan-artifact', () => {
  const actual = jest.requireActual('../common/utils/plan-artifact');
  return {
    ...actual,
    writePlanArtifactManifest: jest.fn().mockReturnValue('/tmp/manifest.json'),
  };
});

jest.mock('../common/utils/extract-figma-links', () => {
  const actual = jest.requireActual('../common/utils/extract-figma-links');
  return {
    extractFigmaLinks: actual.extractFigmaLinks,
    searchFigmaLinksForTicket: jest.fn().mockResolvedValue([]),
    resolvePostParseFigmaLinks: jest.fn().mockImplementation(
      (_content: string, autoLinks: string[]) => Promise.resolve(autoLinks)
    ),
  };
});

jest.mock('../common/utils/resolve-ui-design-screenshots', () => ({
  resolveUiDesignScreenshots: jest.fn().mockReturnValue([]),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssuePlanCommand } from './issue-plan.command';
import { AiService } from '../integrations/ai/ai.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../common/logger/logger.service';
import { CliPresenter } from '../common/presentation/cli-presenter.service';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { hashPlanArtifactSources } from '../common/utils/plan-artifact';
import * as priorPlansModule from '../common/utils/detect-prior-plans';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWfHomeDir } from '../common/utils/wf-paths';
import { createTempDir as createManagedTempDir } from '../common/testing/temp-dir';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(): Promise<{
  command: IssuePlanCommand;
  fetchStageService: jest.Mocked<FetchStageService>;
  planStageService: jest.Mocked<PlanStageService>;
  logger: jest.Mocked<LoggerService>;
}> {
  const module = await Test.createTestingModule({
    providers: [
      IssuePlanCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
          getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
        },
      },
      { provide: IssueTrackerService, useValue: {} },
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
          enrichPlanWithDirectoryConfigs: jest.fn(),
        },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'tracker') return 'jira';
            return defaultValue;
          }),
        },
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
        provide: CliPresenter,
        useValue: {
          stageHeader: jest.fn(),
          separator: jest.fn(),
          progress: jest.fn(),
          outcome: jest.fn(),
          detail: jest.fn(),
          summaryBlock: jest.fn(),
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
    logger: module.get(LoggerService),
  };
}

describe('IssuePlanCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    );
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any)).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('parseFormat', () => {
    it('accepts json|md|yaml|yml', async () => {
      const { command } = await buildCommand();

      expect(command.parseFormat('json')).toBe('json');
      expect(command.parseFormat('md')).toBe('md');
      expect(command.parseFormat('yaml')).toBe('yaml');
      expect(command.parseFormat('yml')).toBe('yml');
    });

    it('rejects xml', async () => {
      const { command } = await buildCommand();

      expect(() => command.parseFormat('xml')).toThrow('Invalid format');
    });
  });

  describe('option metadata', () => {
    it('does not expose a --prompt option', () => {
      const proto = IssuePlanCommand.prototype as any;
      expect(proto.parsePrompt).toBeUndefined();
    });
  });

  describe('parseFigma', () => {
    it('returns true', async () => {
      const { command } = await buildCommand();
      expect((command as any).parseFigma()).toBe(true);
    });
  });

  describe('formatPlanAsMarkdown step intents', () => {
    const basePlan = { action: 'fix', estimatedComplexity: 'low', summary: 'S', steps: ['First', 'Second'] };

    it('emits an Intent line only under the step that has one', async () => {
      const { command } = await buildCommand();

      const md = (command as any).formatPlanAsMarkdown({ ...basePlan, stepIntents: [null, 'goal'] });

      expect(md).toContain('1. First\n2. Second\n   Intent: goal\n\n');
      expect(md).not.toContain('1. First\n   Intent:');
    });

    it('collapses newlines inside an intent so it cannot start a phantom step', async () => {
      const { command } = await buildCommand();

      const md = (command as any).formatPlanAsMarkdown({ ...basePlan, stepIntents: [null, 'goal\n3. fake'] });

      expect(md).toContain('2. Second\n   Intent: goal 3. fake\n');
    });

    it('renders a plan without stepIntents exactly as before', async () => {
      const { command } = await buildCommand();

      const md = (command as any).formatPlanAsMarkdown(basePlan);

      expect(md).toBe(
        '# Implementation Plan\n\n**Action:** fix\n**Complexity:** low\n\n## Summary\n\nS\n\n## Steps\n\n1. First\n2. Second\n\n'
      );
    });

    it('round-trips stepIntents through the markdown parser', async () => {
      const { command } = await buildCommand();
      const md = (command as any).formatPlanAsMarkdown({ ...basePlan, stepIntents: [null, 'goal'] });

      const parsed = require('../common/utils/plan-artifact').parsePlanArtifact(md, '/tmp/plan.md');

      expect(parsed.stepIntents).toEqual([null, 'goal']);
    });
  });

  it('stores custom-mode plans under the artifact repo namespace when --repos is absent', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const artifactPath = path.join(getWfHomeDir(), 'consumer-app', 'bar.md');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return String(input) === artifactPath;
    });
    const statSyncSpy = jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 1024 });

    await command.run([], {
      action: 'fix',
      customPlan: 'bar.md',
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(artifactPath);
    expect(path.dirname(writePreview.filePath)).toBe(path.join(getWfHomeDir(), 'consumer-app'));

    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
  });

  it('stores custom-mode plans under the targeted repo artifact namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const artifactPath = path.join(getWfHomeDir(), 'repo-a', 'bar.md');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return String(input) === artifactPath;
    });
    const statSyncSpy = jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 1024 });

    await command.run([], {
      action: 'fix',
      customPlan: 'bar.md',
      repos: ['repo-a'],
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(artifactPath);
    expect(path.dirname(writePreview.filePath)).toBe(path.join(getWfHomeDir(), 'repo-a'));

    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
  });

  it('uses only the first --repos value for a custom plan and warns about the rest', async () => {
    const { command, logger } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const firstRepoArtifact = path.join(getWfHomeDir(), 'repo-a', 'bar.md');
    const secondRepoArtifact = path.join(getWfHomeDir(), 'repo-b', 'bar.md');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return [firstRepoArtifact, secondRepoArtifact].includes(String(input));
    });
    const statSyncSpy = jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 1024 });

    await command.run([], { action: 'fix', customPlan: 'bar.md', repos: ['repo-a', 'repo-b'], dryRun: true });

    expect(dryRunPreview.previewFileRead.mock.calls[0][0].filePath).toBe(firstRepoArtifact);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring: repo-b'));

    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
  });

  it('does not warn when a custom plan receives a single --repos value', async () => {
    const { command, logger } = await buildCommand();
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    const statSyncSpy = jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 1024 });

    await command.run([], { action: 'fix', customPlan: 'bar.md', repos: ['repo-a'], dryRun: true });

    expect(logger.warn).not.toHaveBeenCalled();

    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
  });

  it('throws when custom source is not found in the artifact repository', async () => {
    await buildCommand();
    const { resolveCustomSourcePath } = require('../common/utils/custom-source');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);

    expect(() => resolveCustomSourcePath('missing.md', '/tmp/consumer-app')).toThrow(
      expect.objectContaining({
        name: 'AppError',
        code: 'FILE_SYSTEM_ERROR',
        message: expect.stringContaining('not found in artifact repository'),
      }),
    );

    existsSyncSpy.mockRestore();
  });

  it('resolves subdirectory-prefixed sources from the artifact repository', async () => {
    await buildCommand();
    const { resolveCustomSourcePath } = require('../common/utils/custom-source');
    const artifactCandidate = path.join(getWfHomeDir(), 'consumer-app', 'jira', 'ticket.md');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return String(input) === artifactCandidate;
    });

    const resolvedPath = resolveCustomSourcePath('jira/ticket.md', '/tmp/consumer-app');

    expect(resolvedPath).toBe(artifactCandidate);

    existsSyncSpy.mockRestore();
  });

  it('rejects --ticket-key + --custom-plan together', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {
      action: 'feature',
      ticketKey: 'WBP-1',
      customPlan: 'bar.md',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--custom-plan');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-markdown custom sources', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {
      action: 'feature',
      customPlan: 'jira/bar.yaml',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('Markdown');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('stores ticket-mode plans under the targeted repo namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      ticketKey: 'WBP-1',
      repos: ['repo-a'],
      dryRun: true,
    });

    const ticketPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(getWfHomeDir(), 'repo-a', 'jira');

    expect(path.dirname(ticketPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('writes hashed ticket-mode plan filenames in dry-run mode', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      ticketKey: 'WBP-1',
      repos: ['repo-a'],
      dryRun: true,
    });

    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    expect(path.basename(planPreview.filePath)).toMatch(
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${hashPlanArtifactSources(['WBP-1'])}-fix-plan\\.json$`),
    );
  });

  it('stores ticket-mode plans under the repo-name namespace for long-format repos', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      ticketKey: 'WBP-1',
      repos: ['workspace/repo-a'],
      dryRun: true,
    });

    const ticketPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(getWfHomeDir(), 'repo-a', 'jira');

    expect(path.dirname(ticketPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('delegates ticket retrieval and plan generation to stage services in live ticket mode', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
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
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'manual-auth-smoke',
              run: 'node -e "require(\'node:assert\').ok(true)"',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(fetchStageService.fetchArtifact).toHaveBeenCalledWith('WBP-1', {
      trackerName: 'jira',
      repo: 'repo-a',
      baseDir: '/tmp/consumer-app/repo-a',
    });
    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      expect.objectContaining({
        action: 'fix',
        ticketKey: 'WBP-1',
        affectedRepositories: ['repo-a'],
        repoDir: '/tmp/consumer-app/repo-a',
      }),
    );
    expect(writeFileSpy).toHaveBeenCalled();
    expect(String(writeFileSpy.mock.calls[0][1])).toContain('"verification"');
  });

  it('extracts Figma links once and threads them into both the plan prompt and the manifest', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const ticketContent = '# WBP-2: Style the card\n\nSee https://figma.com/design/abc123/Card for the frame.';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-2', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-2.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-2', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-2.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style the card', estimatedComplexity: 'low',
        steps: ['Match the frame'], affectedFiles: ['repo-a/src/Card.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);
    const { writePlanArtifactManifest } = jest.requireMock('../common/utils/plan-artifact');

    await command.run([], { action: 'fix', ticketKey: 'WBP-2', repos: ['repo-a'], figma: true });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      ticketContent,
      expect.objectContaining({ figmaLinks: ['https://figma.com/design/abc123/Card'] }),
    );
    expect(writePlanArtifactManifest).toHaveBeenCalledWith(
      expect.objectContaining({ figmaLinks: ['https://figma.com/design/abc123/Card'] }),
    );
  });

  it('passes repo discovery context to generatePlan', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const mockPriorPlans = {
      plans: [
        {
          title: 'prior plan',
          summary: 'prior plan',
          filename: '2026-07-01-abc123-fix-plan.json',
          keywords: ['auth'],
          steps: ['Inspect auth'],
          action: 'fix',
          estimatedComplexity: 'medium',
          ticketKey: 'WBP-1',
        },
      ],
      repoName: 'repo-a',
    };
    const mockPlanCorrelation = { matches: [], repoName: 'repo-a' };
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
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'manual-auth-smoke',
              run: 'node -e "require(\'node:assert\').ok(true)"',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);
    jest.spyOn(priorPlansModule, 'detectPriorPlans').mockReturnValue(mockPriorPlans as any);
    jest.spyOn(priorPlansModule, 'correlatePlans').mockReturnValue(mockPlanCorrelation as any);

    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'fix',
        ticketKey: 'WBP-1',
        affectedRepositories: ['repo-a'],
        repoDir: '/tmp/consumer-app/repo-a',
        planCorrelation: mockPlanCorrelation,
        priorPlans: mockPriorPlans,
      }),
    );
  });

  it('passes plan correlation and raw prior plans in custom-source mode', async () => {
    const { command, planStageService } = await buildCommand();
    const customSourcePath = path.join(getWfHomeDir(), 'consumer-app', 'bar.md');
    const mockPriorPlans = {
      plans: [
        {
          title: 'prior plan',
          summary: 'prior plan',
          filename: '2026-07-01-abc123-fix-plan.json',
          keywords: ['auth'],
          steps: ['Inspect auth'],
          action: 'fix',
          estimatedComplexity: 'medium',
          ticketKey: null,
        },
      ],
      repoName: 'consumer-app',
    };
    const mockPlanCorrelation = { matches: [], repoName: 'consumer-app' };
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      const filePath = String(input);
      return filePath === customSourcePath || filePath === path.join(getWfHomeDir(), 'consumer-app');
    });
    const readFileSyncSpy = jest
      .spyOn(require('fs'), 'readFileSync')
      .mockImplementation((input: fs.PathOrFileDescriptor) => {
        if (String(input) === customSourcePath) {
          return '# Custom issue\n\nRestore auth flow';
        }
        return '';
      });
    jest.spyOn(priorPlansModule, 'detectPriorPlans').mockReturnValue(mockPriorPlans as any);
    jest.spyOn(priorPlansModule, 'correlatePlans').mockReturnValue(mockPlanCorrelation as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['consumer-app/src/auth.ts'],
        affectedRepositories: ['consumer-app'],
      },
    } as any);

    await command.run([], { action: 'fix', customPlan: 'bar.md' });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      '# Custom issue\n\nRestore auth flow',
      expect.objectContaining({
        action: 'fix',
        affectedRepositories: ['consumer-app'],
        repoDir: '/tmp/consumer-app',
        planCorrelation: mockPlanCorrelation,
        priorPlans: mockPriorPlans,
      }),
    );

    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
  });

  it('rejects a generated ticket-mode plan with placeholder repository metadata', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-name/src/auth.ts'],
        affectedRepositories: ['repo-name'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'placeholder repository metadata',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects affectedFilesContext with placeholder prefix', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedFilesContext: ['repo-name/package.json'],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'placeholder repository metadata found in affectedFilesContext',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects affectedFilesContext with invalid repo prefix', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedFilesContext: [{ filePath: 'repo-b/package.json', status: 'found' }],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'affectedFilesContext must use explicit repository prefixes',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects affectedFilesContext entries with to-create status', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedFilesContext: [{ filePath: 'repo-a/package.json', status: 'to-create' }],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'cannot have status "to-create"',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects a generated ticket-mode plan with a non-asserted failing verification command', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'criteria-txt-rejected',
              run: 'wf issue:review --criteria criteria.txt',
              policy: 'enforced',
              reason: 'Expect command to fail for non-Markdown criteria',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'must assert expected failure inside the command',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('recomputes estimatedComplexity from the final validated plan before saving', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'high',
        steps: ['Update the login handler in repo-a/src/auth.ts.'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    const savedPlan = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(savedPlan.estimatedComplexity).toBe('low');
  });

  it('rejects rename steps that omit the replacement target', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Rename AuthService in repo-a/src/auth.ts.'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('rename-target-required');

    const savedPlanContent = writeFileSpy.mock.calls[0][1] as string;
    const savedPlan = JSON.parse(savedPlanContent);
    expect(savedPlan.risks).toBeDefined();
    expect(savedPlan.risks.some((r: { description: string }) => /\[plan-quality\].*rename-target-required/.test(r.description))).toBe(true);

    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects targeted verification commands outside the detected allowlist', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'non-allowlisted-command',
              run: 'ruby -e "puts 1"',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('verification-allowlist');

    const savedPlanContent = writeFileSpy.mock.calls[0][1] as string;
    const savedPlan = JSON.parse(savedPlanContent);
    expect(savedPlan.risks).toBeDefined();
    expect(savedPlan.risks.some((r: { description: string }) => /\[plan-quality\].*verification-allowlist/.test(r.description))).toBe(true);

    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects test guidance that conflicts with detected repo conventions', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const repoDir = createManagedTempDir('plan-quality');
    const repoPath = path.join(repoDir, 'repo-a');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(
      path.join(repoPath, 'src', 'auth.spec.ts'),
      'afterEach(() => { jest.restoreAllMocks(); });\nconst mockUser = {};\nconst createMockUser = () => mockUser;\n',
    );

    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join(repoDir, repo) : repoDir,
    );

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Add repo-a/src/auth/auth.service.test.ts with afterEach(() => jest.resetAllMocks()).'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('mock-cleanup-convention');

    const savedPlanContent = writeFileSpy.mock.calls[0][1] as string;
    const savedPlan = JSON.parse(savedPlanContent);
    expect(savedPlan.risks).toBeDefined();
    expect(savedPlan.risks.some((r: { description: string }) => /\[plan-quality\].*mock-cleanup-convention/.test(r.description))).toBe(true);

    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('normalizes targeted verification commands that redundantly cd into the selected repo', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
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
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'repo-relative-test',
              run: 'cd repo-a && node -e "require(\'node:assert\').ok(true)"',
              policy: 'enforced',
            },
            {
              id: 'absolute-repo-test',
              run: 'cd /tmp/consumer-app/repo-a && node -e "process.exit(0)"',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    const writtenPlan = JSON.parse(String(writeFileSpy.mock.calls[0][1]));
    expect(writtenPlan.verification.targeted).toEqual([
      expect.objectContaining({
        id: 'repo-relative-test',
        run: 'node -e "require(\'node:assert\').ok(true)"',
      }),
      expect.objectContaining({
        id: 'absolute-repo-test',
        run: 'node -e "process.exit(0)"',
      }),
    ]);
  });

  it('rejects targeted verification commands that cd outside the selected repo', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'wrong-repo-test',
              run: 'cd repo-b && yarn test',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'must not change directories outside the selected repository',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects enforced verification referencing a nonexistent package.json script', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const repoDir = createManagedTempDir('plan-infra');
    const repoPath = path.join(repoDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join(repoDir, repo) : repoDir,
    );

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: path.join(repoDir, '.wf', 'repo-a', 'jira', 'WBP-1.md'),
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'nonexistent-script',
              run: 'yarn test:integration -- --bail',
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'does not exist in package.json',
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it.each([
    ['pnpm run test:manual test-auth-redirect'],
    ['bun run test:manual test-auth-redirect'],
  ])('allows enforced verification referencing an existing script through %s', async run => {
    const { command, fetchStageService, planStageService } = await buildCommand();

    const repoDir = createManagedTempDir('plan-infra');
    const repoPath = path.join(repoDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest', 'test:manual': 'ts-node run-manual-test.ts' } }),
    );

    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join(repoDir, repo) : repoDir,
    );

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: path.join(repoDir, '.wf', 'repo-a', 'jira', 'WBP-1.md'),
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: path.join(repoDir, '.wf', 'repo-a', 'jira', 'WBP-1.md'),
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'existing-script',
              run,
              policy: 'enforced',
            },
          ],
        },
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    // Validation passed — the plan was written (script exists in package.json)
    expect(writeFileSpy).toHaveBeenCalled();

    writeFileSpy.mockRestore();
  });

  it('deletes sibling standard plans before writing a new ticket plan', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
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
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);

    jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      const filePath = String(input);
      return (
        filePath.endsWith('WBP-1.md')
        || filePath.endsWith('WBP-1-plan-feature.json')
        || filePath.endsWith('WBP-1-plan-investigate.md')
      );
    });
    const unlinkSyncSpy = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(getWfHomeDir(), 'repo-a', 'jira', 'WBP-1-plan-feature.json'),
    );
    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(getWfHomeDir(), 'repo-a', 'jira', 'WBP-1-plan-investigate.md'),
    );
  });

  it('passes onProgress to generatePlan when not silent', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'] });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('passes undefined onProgress to generatePlan when silent', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix login',
        estimatedComplexity: 'medium',
        steps: ['Inspect auth'],
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-1', repos: ['repo-a'], silent: true });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ onProgress: undefined }),
    );
  });

  it('produces deterministic hash for same custom source across runs', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const artifactPath = path.join(getWfHomeDir(), 'consumer-app', 'foo.md');
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return String(input) === artifactPath;
    });
    const statSyncSpy = jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 512 });

    await command.run([], { action: 'fix', customPlan: 'foo.md', dryRun: true });
    const firstFilename = path.basename(dryRunPreview.previewFileWrite.mock.calls[0][0].filePath);

    dryRunPreview.previewFileWrite.mockClear();

    await command.run([], { action: 'fix', customPlan: 'foo.md', dryRun: true });
    const secondFilename = path.basename(dryRunPreview.previewFileWrite.mock.calls[0][0].filePath);

    expect(firstFilename).toBe(secondFilename);
    expect(firstFilename).toContain(hashPlanArtifactSources(['foo']));

    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
  });

  it('accepts --ticket-key and passes it through to fetch and plan stages', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-99',
      content: '# WBP-99\n\nDescription',
      path: '/tmp/.wf/repo-a/jira/WBP-99.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-99',
      content: '# WBP-99\n\nDescription',
      path: '/tmp/.wf/repo-a/jira/WBP-99.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Fix',
        estimatedComplexity: 'low',
        steps: ['Step 1'],
        affectedFiles: ['repo-a/src/a.ts'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-99', repos: ['repo-a'] });

    expect(fetchStageService.fetchArtifact).toHaveBeenCalledWith('WBP-99', expect.anything());
  });

  it('rejects empty input when neither --ticket-key nor --custom-plan is provided', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], { action: 'fix' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--ticket-key');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('calls planStageService.enrichPlanWithDirectoryConfigs after validateGeneratedPlan', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-TEST',
      content: '# WBP-TEST: Test\n\n## Description\n\nTest enrichment',
      path: '/tmp/.wf/repo-a/jira/WBP-TEST.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-TEST',
      content: '# WBP-TEST: Test\n\n## Description\n\nTest enrichment',
      path: '/tmp/.wf/repo-a/jira/WBP-TEST.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix',
        summary: 'Test',
        estimatedComplexity: 'low',
        steps: ['Test'],
        affectedFiles: ['repo-a/src/test.ts'],
        affectedRepositories: ['repo-a'],
      },
      sessionId: undefined,
    });

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    cwdSpy.mockReturnValue(mockCwd);

    await command.run([], {
      ticketKey: 'WBP-TEST',
      action: 'fix',
      repos: ['repo-a'],
    });

    expect(planStageService.enrichPlanWithDirectoryConfigs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'fix',
        summary: 'Test',
      }),
      expect.any(String),
    );

    writeFileSpy.mockRestore();
  });

  it('writes Figma links returned by resolvePostParseFigmaLinks into the manifest when content has no inline links', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const { resolvePostParseFigmaLinks } = jest.requireMock('../common/utils/extract-figma-links');
    const { writePlanArtifactManifest } = jest.requireMock('../common/utils/plan-artifact');
    (resolvePostParseFigmaLinks as jest.Mock).mockResolvedValueOnce(['https://figma.com/design/abc123/Card']);

    const ticketContent = '# WBP-600: Style the button';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-600', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-600.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-600', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-600.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style the button', estimatedComplexity: 'low',
        steps: ['Update styles'], affectedFiles: ['repo-a/src/Button.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-600', repos: ['repo-a'], figma: true });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      ticketContent,
      expect.objectContaining({ figmaLinks: [] }),
    );
    expect(writePlanArtifactManifest).toHaveBeenCalledWith(
      expect.objectContaining({ figmaLinks: ['https://figma.com/design/abc123/Card'] }),
    );
  });

  it('skips Figma link extraction when neither --figma nor stages.plan.figma is set', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const { resolvePostParseFigmaLinks } = jest.requireMock('../common/utils/extract-figma-links');
    (resolvePostParseFigmaLinks as jest.Mock).mockClear();
    const { writePlanArtifactManifest } = jest.requireMock('../common/utils/plan-artifact');

    const ticketContent = '# WBP-700: Style the button\n\nSee https://figma.com/design/abc123/Card for the frame.';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-700', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-700.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-700', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-700.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style the button', estimatedComplexity: 'low',
        steps: ['Update styles'], affectedFiles: ['repo-a/src/Button.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-700', repos: ['repo-a'] });

    expect(resolvePostParseFigmaLinks).not.toHaveBeenCalled();
    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      ticketContent,
      expect.objectContaining({ figmaLinks: [] }),
    );
    expect(writePlanArtifactManifest).toHaveBeenCalledWith(
      expect.objectContaining({ figmaLinks: undefined }),
    );
  });

  it('extracts Figma links when stages.plan.figma is true in config and --figma is not passed', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssuePlanCommand,
        { provide: AiService, useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'), getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions') } },
        { provide: IssueTrackerService, useValue: {} },
        { provide: FetchStageService, useValue: { fetchArtifact: jest.fn(), loadArtifact: jest.fn() } },
        { provide: PlanStageService, useValue: { generatePlan: jest.fn(), enrichPlanWithDirectoryConfigs: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'tracker') return 'jira';
              if (key === 'stages.plan.figma') return true;
              return defaultValue;
            }),
          },
        },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
        },
        {
          provide: CliPresenter,
          useValue: {
            stageHeader: jest.fn(), separator: jest.fn(), progress: jest.fn(),
            outcome: jest.fn(), detail: jest.fn(), summaryBlock: jest.fn(),
          },
        },
        {
          provide: DryRunPreviewService,
          useValue: {
            showHeader: jest.fn(), showSummary: jest.fn(), showValidationResult: jest.fn(),
            previewApiCall: jest.fn(), previewFileRead: jest.fn(), previewFileWrite: jest.fn(),
          },
        },
      ],
    }).compile();
    const command = module.get(IssuePlanCommand);
    const fetchStageService = module.get<jest.Mocked<FetchStageService>>(FetchStageService);
    const planStageService = module.get<jest.Mocked<PlanStageService>>(PlanStageService);
    const { writePlanArtifactManifest } = jest.requireMock('../common/utils/plan-artifact');

    const ticketContent = '# WBP-800: Style the card\n\nSee https://figma.com/design/abc123/Card for the frame.';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-800', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-800.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-800', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-800.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style the card', estimatedComplexity: 'low',
        steps: ['Match the frame'], affectedFiles: ['repo-a/src/Card.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-800', repos: ['repo-a'] });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      ticketContent,
      expect.objectContaining({ figmaLinks: ['https://figma.com/design/abc123/Card'] }),
    );
    expect(writePlanArtifactManifest).toHaveBeenCalledWith(
      expect.objectContaining({ figmaLinks: ['https://figma.com/design/abc123/Card'] }),
    );
  });

  it('writes uiDesignScreenshots into plan JSON when --ui-design-screenshots provided', async () => {
    const { resolveUiDesignScreenshots } = jest.requireMock('../common/utils/resolve-ui-design-screenshots');
    resolveUiDesignScreenshots.mockReturnValue(['/abs/design.png']);
    const { command, fetchStageService, planStageService } = await buildCommand();
    const ticketContent = '# WBP-3: Style the button';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-3', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-3.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-3', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-3.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style button', estimatedComplexity: 'low',
        steps: ['Update CSS'], affectedFiles: ['repo-a/src/Button.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    const writtenContents: string[] = [];
    jest.spyOn(require('fs').promises, 'writeFile').mockImplementation((_p: any, data: any) => {
      writtenContents.push(data as string);
      return Promise.resolve();
    });

    await command.run([], { action: 'fix', ticketKey: 'WBP-3', repos: ['repo-a'], uiDesignScreenshots: ['design.png'] });

    const written = JSON.parse(writtenContents[0]);
    expect(written.uiDesignScreenshots).toEqual(['/abs/design.png']);
  });

  it('rejects --figma and --ui-design-screenshots together', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], { action: 'fix', ticketKey: 'WBP-4', repos: ['repo-a'], figma: true, uiDesignScreenshots: ['design.png'] } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('mutually exclusive');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('calls resolveUiDesignScreenshots with rawFiles=[] when --ui-design-screenshots has no files', async () => {
    const { resolveUiDesignScreenshots } = jest.requireMock('../common/utils/resolve-ui-design-screenshots');
    resolveUiDesignScreenshots.mockReturnValue([]);
    const { command, fetchStageService, planStageService } = await buildCommand();
    const ticketContent = '# WBP-5: Style the footer';
    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-5', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-5.md',
    });
    fetchStageService.loadArtifact.mockReturnValue({
      ticketKey: 'WBP-5', content: ticketContent, path: '/tmp/.wf/repo-a/jira/WBP-5.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      plan: {
        action: 'fix', summary: 'Style footer', estimatedComplexity: 'low',
        steps: ['Update CSS'], affectedFiles: ['repo-a/src/Footer.vue'],
        affectedRepositories: ['repo-a'],
      },
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run([], { action: 'fix', ticketKey: 'WBP-5', repos: ['repo-a'], uiDesignScreenshots: [] });

    expect(resolveUiDesignScreenshots).toHaveBeenCalledWith([], expect.any(String), 'WBP-5');
  });
});
