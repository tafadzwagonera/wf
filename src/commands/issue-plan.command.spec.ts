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

jest.mock('../shared/utils/plan-artifact', () => {
  const actual = jest.requireActual('../shared/utils/plan-artifact');
  return {
    ...actual,
    writePlanArtifactManifest: jest.fn().mockReturnValue('/tmp/manifest.json'),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssuePlanCommand } from './issue-plan.command';
import { AiService } from '../integrations/ai/ai.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { hashPlanArtifactSources } from '../shared/utils/plan-artifact';
import * as priorPlansModule from '../shared/utils/detect-prior-plans';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWfHomeDir } from '../shared/utils/wf-paths';
import { createTempDir as createManagedTempDir } from '../shared/testing/temp-dir';

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

  it('resolves from the targeted repo artifact namespace when --repos is provided', async () => {
    await buildCommand();
    const { resolveCustomSourcePath } = require('../shared/utils/custom-source');
    const repoName = 'repo-a';
    const sourceName = 'bar.md';
    const repoCandidate = path.join(getWfHomeDir(), repoName, sourceName);
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      return String(input) === repoCandidate;
    });

    const resolvedPath = resolveCustomSourcePath(sourceName, '/tmp/consumer-app', [repoName]);

    expect(resolvedPath).toBe(repoCandidate);

    existsSyncSpy.mockRestore();
  });

  it('throws when custom source is not found in the artifact repository', async () => {
    await buildCommand();
    const { resolveCustomSourcePath } = require('../shared/utils/custom-source');
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
    const { resolveCustomSourcePath } = require('../shared/utils/custom-source');
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
    expect(savedPlan.risks.some((r: string) => /\[plan-quality\].*rename-target-required/.test(r))).toBe(true);

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
    expect(savedPlan.risks.some((r: string) => /\[plan-quality\].*verification-allowlist/.test(r))).toBe(true);

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
    expect(savedPlan.risks.some((r: string) => /\[plan-quality\].*mock-cleanup-convention/.test(r))).toBe(true);

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

  it('allows enforced verification referencing an existing package.json script', async () => {
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
              run: 'yarn test:manual -- test-auth-redirect',
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
});
