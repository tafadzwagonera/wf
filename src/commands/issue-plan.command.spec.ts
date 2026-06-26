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
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { hashPlanArtifactSources } from '../shared/utils/plan-artifact';
import * as fs from 'fs';
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

  it('stores custom-mode plans under the cwd custom namespace when --repos is absent', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      custom: 'bar.md',
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(path.join(os.homedir(), '.wf', 'consumer-app', 'bar.md'));
    expect(path.dirname(writePreview.filePath)).toBe(path.join(os.homedir(), '.wf', 'consumer-app'));
  });

  it('stores custom-mode plans under the targeted repo custom namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run([], {
      action: 'fix',
      custom: 'bar.md',
      repos: ['repo-a'],
      dryRun: true,
    });

    const readPreview = dryRunPreview.previewFileRead.mock.calls[0][0];
    const writePreview = dryRunPreview.previewFileWrite.mock.calls[0][0];

    expect(readPreview.filePath).toBe(path.join(os.homedir(), '.wf', 'repo-a', 'bar.md'));
    expect(path.dirname(writePreview.filePath)).toBe(path.join(os.homedir(), '.wf', 'repo-a'));
  });

  it('prefers the targeted repo custom namespace over cwd when --repos is provided', async () => {
    const { command } = await buildCommand();
    const repoName = 'repo-a';
    const sourceName = 'bar.md';
    const cwdCandidate = path.join('/tmp/consumer-app', sourceName);
    const repoCandidate = path.join(os.homedir(), '.wf', repoName, sourceName);
    const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      const filePath = String(input);
      return filePath === cwdCandidate || filePath === repoCandidate;
    });

    const resolvedPath = (command as any).resolveCustomSourcePath(sourceName, '/tmp/consumer-app', [repoName]);

    expect(resolvedPath).toBe(repoCandidate);

    existsSyncSpy.mockRestore();
  });

  it('rejects ticket-key + --custom together', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['WBP-1'], {
      action: 'feature',
      custom: 'bar.md',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--custom');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-markdown custom sources', async () => {
    const { command } = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {
      action: 'feature',
      custom: 'jira/bar.yaml',
    } as any);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('Markdown');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('stores ticket-mode plans under the targeted repo namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

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

  it('writes hashed ticket-mode plan filenames in dry-run mode', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      action: 'fix',
      repos: ['repo-a'],
      dryRun: true,
    });

    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    expect(path.basename(planPreview.filePath)).toMatch(
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${hashPlanArtifactSources(['WBP-1'])}-fix-plan\\.json$`)
    );
  });

  it('stores ticket-mode plans under the repo-name namespace for long-format repos', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'manual-auth-smoke',
            run: 'node -e "require(\'node:assert\').ok(true)"',
            policy: 'enforced',
          },
        ],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

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
      })
    );
    expect(writeFileSpy).toHaveBeenCalled();
    expect(String(writeFileSpy.mock.calls[0][1])).toContain('"verification"');
  });

  it('passes repo discovery context to generatePlan', async () => {
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'manual-auth-smoke',
            run: 'node -e "require(\'node:assert\').ok(true)"',
            policy: 'enforced',
          },
        ],
      },
    } as any);

    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'fix',
        ticketKey: 'WBP-1',
        affectedRepositories: ['repo-a'],
        repoDir: '/tmp/consumer-app/repo-a',
      })
    );
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-name/src/auth.ts'],
      repositoriesAffected: ['repo-name'],
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'placeholder repository metadata'
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects filesContext with placeholder prefix', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      filesContext: ['repo-name/package.json'],
      repositoriesAffected: ['repo-a'],
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'placeholder repository metadata found in filesContext'
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects filesContext with invalid repo prefix', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      filesContext: [{ filePath: 'repo-b/package.json', status: 'found' }],
      repositoriesAffected: ['repo-a'],
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'filesContext must use explicit repository prefixes'
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects filesContext entries with to-create status', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: '/tmp/.wf/repo-a/jira/WBP-1.md',
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      filesContext: [{ filePath: 'repo-a/package.json', status: 'to-create' }],
      repositoriesAffected: ['repo-a'],
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'cannot have status "to-create"'
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
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
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'must assert expected failure inside the command'
    );

    consoleErrorSpy.mockRestore();
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
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
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'wrong-repo-test',
            run: 'cd repo-b && yarn test',
            policy: 'enforced',
          },
        ],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'must not change directories outside the selected repository'
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects enforced verification referencing a nonexistent package.json script', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-infra-'));
    const repoPath = path.join(repoDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join(repoDir, repo) : repoDir
    );

    fetchStageService.fetchArtifact.mockResolvedValue({
      ticketKey: 'WBP-1',
      content: '# WBP-1: Fix login\n\n## Description\n\nRestore auth flow',
      path: path.join(repoDir, '.wf', 'repo-a', 'jira', 'WBP-1.md'),
    });
    planStageService.generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'nonexistent-script',
            run: 'yarn test:integration -- --bail',
            policy: 'enforced',
          },
        ],
      },
    } as any);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain(
      'does not exist in package.json'
    );

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('allows enforced verification referencing an existing package.json script', async () => {
    const { command, fetchStageService, planStageService } = await buildCommand();

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-infra-'));
    const repoPath = path.join(repoDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest', 'test:manual': 'ts-node run-manual-test.ts' } })
    );

    const { resolveRepoBasePath } = require('../agents/utils');
    (resolveRepoBasePath as jest.Mock).mockImplementation((repo?: string) =>
      repo ? path.join(repoDir, repo) : repoDir
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'existing-script',
            run: 'yarn test:manual -- test-auth-redirect',
            policy: 'enforced',
          },
        ],
      },
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
    } as any);

    jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
      const filePath = String(input);
      return (
        filePath.endsWith('WBP-1.md') ||
        filePath.endsWith('WBP-1-plan-feature.json') ||
        filePath.endsWith('WBP-1-plan-investigate.md')
      );
    });
    const unlinkSyncSpy = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(os.homedir(), '.wf', 'repo-a', 'jira', 'WBP-1-plan-feature.json')
    );
    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      path.join(os.homedir(), '.wf', 'repo-a', 'jira', 'WBP-1-plan-investigate.md')
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'] });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ onProgress: expect.any(Function) })
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
      action: 'fix',
      summary: 'Fix login',
      estimatedComplexity: 'medium',
      steps: ['Inspect auth'],
      filesAffected: ['repo-a/src/auth.ts'],
      repositoriesAffected: ['repo-a'],
    } as any);
    jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { action: 'fix', repos: ['repo-a'], silent: true });

    expect(planStageService.generatePlan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ onProgress: undefined })
    );
  });
});
