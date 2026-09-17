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
    scaffoldNewRepo: jest.fn((repo: string, baseDir: string) => path.join(baseDir, '..', repo)),
  };
});

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

jest.mock('../config/wf-config-loader', () => ({
  initializeWfConfig: jest.fn().mockResolvedValue({}),
  getLoadedWfConfig: jest.fn().mockReturnValue({ tracker: 'jira' }),
}));

import { Test } from '@nestjs/testing';
import { IssueImplementCommand } from './issue-implement.command';
import { AiService } from '../integrations/ai/ai.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import { buildPlanArtifactManifestPath, hashPlanArtifactSources } from '../shared/utils/plan-artifact';
import { AmbiguousPlanArtifactError } from '../shared/utils/errors';
import * as path from 'node:path';
import { getWfHomeDir } from '../shared/utils/wf-paths';
import { initializeWfConfig } from '../config/wf-config-loader';

async function buildCommand(): Promise<IssueImplementCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueImplementCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
          getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
          execute: jest.fn().mockResolvedValue({ content: '{}' }),
        },
      },
      { provide: IssueTrackerService, useValue: {} },
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
    jest.restoreAllMocks();
  });

  it('prints the command header when --silent is not set', async () => {
    const command = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await command.run([], { dryRun: true });

    const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(allOutput).toContain('Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact.');
    expect(allOutput).toContain('Examples:');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const command = await buildCommand();

      expect(command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any)).toEqual(['repo-a', 'workspace/repo-b']);
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

  describe('custom plan identifier validation', () => {
    it('rejects unsupported file extensions for non-ticket identifiers', async () => {
      const command = await buildCommand();
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await command.run(['merry-tinkering-pine-feature.txt'], {
        dryRun: true,
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('supported file extension');

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('resolves a custom plan stem by finding the matching supported artifact', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(path.join('.wf', 'repo-a', 'dark-building-creek-fix.json')),
        );
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'fix',
          summary: 'Repair the custom implementation path',
          steps: ['Route custom plans to the shared implementer'],
          affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'],
          affectedRepositories: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-fix'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(getWfHomeDir(), 'repo-a', 'dark-building-creek-fix.json'),
        }),
      );
    });

    it('resolves a hashed standard plan artifact without requiring --action', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const artifactDir = path.join(getWfHomeDir(), 'repo-a', 'jira');
      const planPath = path.join(artifactDir, `2026-04-16-${hash}-fix-plan.json`);
      const manifestPath = buildPlanArtifactManifestPath(planPath);
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation(
          (input: string) =>
            String(input) === artifactDir
            || String(input) === planPath
            || String(input) === manifestPath
            || String(input).endsWith('WBP-0001.md'),
        );
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(manifestPath)] as any);
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath.endsWith('WBP-0001.md')) {
          return '# WBP-0001: Fix login\n\n## Description\n\nRestore auth flow';
        }
        if (filePath === manifestPath) {
          return JSON.stringify({
            artifactPath: planPath,
            action: 'fix',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
            trackerName: 'jira',
          });
        }
        return JSON.stringify({
          action: 'fix',
          summary: 'Repair the cached plan',
          steps: ['Patch the login flow'],
          affectedFiles: ['repo-a/src/auth.ts'],
          affectedRepositories: ['repo-a'],
        });
      });

      jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

      await command.run([`2026-04-16-${hash}-fix-plan.json`], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(getWfHomeDir(), 'repo-a', 'jira', `2026-04-16-${hash}-fix-plan.json`),
        }),
      );
    });
  });

  describe('AmbiguousPlanArtifactError propagation', () => {
    it('safePlanResolve returns null when no artifact matches', async () => {
      const command = await buildCommand();
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);

      const artifactDir = path.join(getWfHomeDir(), 'repo-a', 'jira');
      const result = (command as any).safePlanResolve('WBP-NOTFOUND', artifactDir);

      expect(result).toBeNull();
    });

    it('safePlanResolve rethrows AmbiguousPlanArtifactError instead of swallowing it into a guessed action', async () => {
      const command = await buildCommand();
      const trackerDir = path.join(getWfHomeDir(), 'repo-a', 'jira');
      const hash1 = hashPlanArtifactSources(['WBP-0001-a']);
      const hash2 = hashPlanArtifactSources(['WBP-0001-b']);
      const planPath1 = path.join(trackerDir, `2026-04-16-${hash1}-fix-plan.json`);
      const planPath2 = path.join(trackerDir, `2026-04-17-${hash2}-fix-plan.json`);
      const manifestPath1 = buildPlanArtifactManifestPath(planPath1);
      const manifestPath2 = buildPlanArtifactManifestPath(planPath2);

      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          [trackerDir, planPath1, planPath2, manifestPath1, manifestPath2].includes(String(input)),
        );
      jest.spyOn(require('fs'), 'readdirSync').mockImplementation((input: any) =>
        String(input) === trackerDir
          ? [path.basename(manifestPath1), path.basename(manifestPath2)]
          : [],
      );
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath === manifestPath1) {
          return JSON.stringify({
            artifactPath: planPath1,
            action: 'fix',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash: hash1,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
            trackerName: 'jira',
          });
        }
        return JSON.stringify({
          artifactPath: planPath2,
          action: 'fix',
          createdAt: new Date('2026-04-17T00:00:00.000Z').toISOString(),
          format: 'json',
          hash: hash2,
          sourceKind: 'ticket',
          sourceName: 'WBP-0001',
          ticketKey: 'WBP-0001',
          trackerName: 'jira',
        });
      });

      expect(() => (command as any).safePlanResolve('WBP-0001', trackerDir)).toThrow(AmbiguousPlanArtifactError);
    });

    it('resolvePlanArtifactReferenceAcrossDirs stops at the first ambiguous directory without checking the next one', async () => {
      const command = await buildCommand();
      const trackerDir = path.join(getWfHomeDir(), 'repo-a', 'jira');
      const customArtifactDir = path.join(getWfHomeDir(), 'repo-a');
      const hash1 = hashPlanArtifactSources(['range-rename-a']);
      const hash2 = hashPlanArtifactSources(['range-rename-b']);
      const planPath1 = path.join(trackerDir, `2026-08-24-${hash1}-fix-plan.json`);
      const planPath2 = path.join(trackerDir, `2026-08-25-${hash2}-fix-plan.json`);
      const manifestPath1 = buildPlanArtifactManifestPath(planPath1);
      const manifestPath2 = buildPlanArtifactManifestPath(planPath2);
      const customHash = hashPlanArtifactSources(['range-rename']);
      const customPlanPath = path.join(customArtifactDir, `2026-08-25-${customHash}-fix-plan.json`);
      const customManifestPath = buildPlanArtifactManifestPath(customPlanPath);

      const readdirSyncSpy = jest
        .spyOn(require('fs'), 'readdirSync')
        .mockImplementation((input: any) => {
          if (String(input) === trackerDir) return [path.basename(manifestPath1), path.basename(manifestPath2)];
          if (String(input) === customArtifactDir) return [path.basename(customManifestPath)];
          return [];
        });
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          [
            trackerDir,
            customArtifactDir,
            planPath1,
            planPath2,
            manifestPath1,
            manifestPath2,
            customPlanPath,
            customManifestPath,
          ].includes(String(input)),
        );
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath === manifestPath1) {
          return JSON.stringify({
            artifactPath: planPath1,
            action: 'fix',
            createdAt: new Date('2026-08-24T00:00:00.000Z').toISOString(),
            format: 'json',
            hash: hash1,
            sourceKind: 'custom',
            sourceName: 'range-rename',
            customArtifactName: 'range-rename',
          });
        }
        if (filePath === manifestPath2) {
          return JSON.stringify({
            artifactPath: planPath2,
            action: 'fix',
            createdAt: new Date('2026-08-25T00:00:00.000Z').toISOString(),
            format: 'json',
            hash: hash2,
            sourceKind: 'custom',
            sourceName: 'range-rename',
            customArtifactName: 'range-rename',
          });
        }
        return JSON.stringify({
          artifactPath: customPlanPath,
          action: 'fix',
          createdAt: new Date('2026-08-25T00:00:00.000Z').toISOString(),
          format: 'json',
          hash: customHash,
          sourceKind: 'custom',
          sourceName: 'range-rename',
          customArtifactName: 'range-rename',
        });
      });

      expect(() =>
        (command as any).resolvePlanArtifactReferenceAcrossDirs('range-rename', trackerDir, customArtifactDir, '/tmp/consumer-app/repo-a'),
      ).toThrow(AmbiguousPlanArtifactError);

      const checkedDirs = readdirSyncSpy.mock.calls.map(call => String(call[0]));
      expect(checkedDirs).toContain(trackerDir);
      expect(checkedDirs).not.toContain(customArtifactDir);
    });
  });

  describe('Mode C — preflight checks (live path)', () => {
    let command: IssueImplementCommand;
    let exitSpy: jest.SpyInstance;
    let existsSyncSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(async () => {
      command = await buildCommand();
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('exits with code 1 and prints fetch hint when ticket artifact is missing', async () => {
      existsSyncSpy.mockReturnValue(false);

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Ticket artifact not found');
      expect(errorOutput).toContain('issue:fetch');
      expect(errorOutput).toContain(path.join(getWfHomeDir(), 'repo-a', 'jira', 'WBP-0001.md'));
      expect(errorOutput).toContain('--repos repo-a');
      expect(errorOutput).not.toContain('--repos repo-a,');
    });

    it('exits with code 1 and prints plan hint when ticket exists but plan is missing', async () => {
      existsSyncSpy.mockImplementation((p: string) => String(p).endsWith(path.join('jira', 'WBP-0001.md')));

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls.map(c => c.join(' ')).join('\n');
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
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
      dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('exits with code 1 and does not render preview when ticket artifact is missing', async () => {
      existsSyncSpy.mockReturnValue(false);

      await command.run([], { ticketKey: 'WBP-0001', dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
    });

    it('exits with code 1 and does not render preview when plan artifact is missing', async () => {
      existsSyncSpy.mockImplementation((p: string) => String(p).endsWith('.md'));

      await command.run([], { ticketKey: 'WBP-0001', dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
    });

    it('previews two file-reads and shows summary with zero counts when both artifacts exist (feature plan)', async () => {
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const canonicalPlanPath = path.join(
        getWfHomeDir(), 'repo-a',
        'jira',
        `2026-04-16-${hash}-feature-plan.json`,
      );
      const canonicalManifestPath = buildPlanArtifactManifestPath(canonicalPlanPath);
      // Allow ticket .md and only the feature plan so discoverPlanAction resolves
      // to action='feature' (investigate is first in candidates and would win with
      // equal mtimeMs if we simply mockReturnValue(true)).
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md')
          || String(p).endsWith('/jira')
          || String(p) === canonicalPlanPath
          || String(p) === canonicalManifestPath,
      );
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(canonicalManifestPath)] as any);
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        if (String(input) === canonicalManifestPath) {
          return JSON.stringify({
            artifactPath: canonicalPlanPath,
            action: 'feature',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
          });
        }
        return JSON.stringify({ action: 'feature' });
      });

      await command.run([], { ticketKey: 'WBP-0001', dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(dryRunPreview.previewFileRead).toHaveBeenCalledTimes(2);
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({ apiCallCount: 0, fileCreatedCount: 0 }),
      );
    });

    it('shows apiCallCount: 1 and fileCreatedCount: 1 for investigate plan dry-run', async () => {
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const canonicalPlanPath = path.join(
        getWfHomeDir(), 'repo-a',
        'jira',
        `2026-04-16-${hash}-investigate-plan.json`,
      );
      const canonicalManifestPath = buildPlanArtifactManifestPath(canonicalPlanPath);
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md')
          || String(p).endsWith('/jira')
          || String(p) === canonicalPlanPath
          || String(p) === canonicalManifestPath,
      );
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(canonicalManifestPath)] as any);
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        if (String(input) === canonicalManifestPath) {
          return JSON.stringify({
            artifactPath: canonicalPlanPath,
            action: 'investigate',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
          });
        }
        return JSON.stringify({ action: 'investigate' });
      });

      await command.run([], { ticketKey: 'WBP-0001', dryRun: true, repos: ['repo-a'] });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({ apiCallCount: 1, fileCreatedCount: 1 }),
      );
    });
  });

  describe('custom plan mode', () => {
    it('resolves a custom filename from the repo custom namespace in dry-run mode', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(path.join('.wf', 'repo-a', 'merry-tinkering-pine-feature.json')),
        );
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(JSON.stringify({ action: 'feature', steps: [] }));

      await command.run(['merry-tinkering-pine-feature.json'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(getWfHomeDir(), 'repo-a', 'merry-tinkering-pine-feature.json'),
        }),
      );
    });

    it('calls the implementer for a custom fix plan using a synthetic execution context', async () => {
      const command = await buildCommand();
      const consoleWarnSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(path.join('.wf', 'repo-a', 'dark-building-creek-fix.json')),
        );
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'fix',
          summary: 'Repair the failing custom workflow',
          steps: ['Update the implement command'],
          affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'],
          affectedRepositories: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-fix.json'], {
        repos: ['repo-a'],
      });

      const mockOrchestrator = (command as any).orchestrator as jest.Mocked<AgentOrchestrator>;
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketKey: 'dark-building-creek',
          path: path.join(getWfHomeDir(), 'repo-a', 'dark-building-creek-fix.json'),
          content: expect.stringContaining('# dark-building-creek:'),
        }),
        expect.objectContaining({
          action: 'fix',
          path: path.join(getWfHomeDir(), 'repo-a', 'dark-building-creek-fix.json'),
        }),
        expect.objectContaining({
          trackerName: 'jira',
          repoDir: '/tmp/consumer-app/repo-a',
          customBranchSlug: 'dark-building-creek',
        }),
      );
      expect(
        consoleWarnSpy.mock.calls.some(call => String(call[0]).includes('synthetic execution context for custom plan')),
      ).toBe(true);

      consoleWarnSpy.mockRestore();
    });

    it('previews branch and file work for a custom feature dry-run', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation((input: string) =>
          String(input).endsWith(path.join('.wf', 'repo-a', 'dark-building-creek-feature.json')),
        );
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
        JSON.stringify({
          action: 'feature',
          summary: 'Implement the custom workflow',
          steps: ['Update the implement command'],
          affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'],
          affectedRepositories: ['repo-a'],
        }),
      );

      await command.run(['dark-building-creek-feature.json'], {
        repos: ['repo-a'],
        dryRun: true,
      });

      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/tmp/consumer-app/repo-a/src/commands/issue-implement.command.ts',
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
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const canonicalPlanName = `2026-04-16-${hash}-feature-plan.md`;
      const canonicalPlanPath = path.join(getWfHomeDir(), 'repo-a', 'jira', canonicalPlanName);
      const canonicalManifestPath = buildPlanArtifactManifestPath(canonicalPlanPath);
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
              getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
            },
          },
          { provide: IssueTrackerService, useValue: {} },
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

      jest.spyOn(require('fs'), 'existsSync').mockImplementation((input: string) => {
        const filePath = String(input);
        return (
          filePath.endsWith('WBP-0001.md')
          || filePath === canonicalPlanPath
          || filePath === canonicalManifestPath
          || filePath.endsWith('/jira')
        );
      });
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(canonicalManifestPath)] as any);
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs').promises, 'readFile').mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath === canonicalManifestPath) {
          return JSON.stringify({
            artifactPath: canonicalPlanPath,
            action: 'feature',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'md',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
          });
        }
        return [
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
        ].join('\n');
      });

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a'] });

      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      const [, planArg] = mockOrchestrator.implementer.execute.mock.calls[0];
      expect(planArg.path).toBe(canonicalPlanPath);
      expect(planArg.plan.steps).toEqual(['First step']);
    });
  });

  // Keep the happy-path live test inside its own describe
  describe('Mode C — happy path (live)', () => {
    let exitSpy: jest.SpyInstance;
    let existsSyncSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it('reads ticket and plan from disk and calls implementer when both artifacts exist', async () => {
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const canonicalPlanPath = path.join(
        getWfHomeDir(), 'repo-a',
        'jira',
        `2026-04-16-${hash}-feature-plan.json`,
      );
      const canonicalManifestPath = buildPlanArtifactManifestPath(canonicalPlanPath);
      // Allow ticket .md and only the feature plan so discoverPlanAction resolves
      // to action='feature' (investigate is first in the candidates array and would
      // win when all mtimeMs are equal if we simply mockReturnValue(true)).
      existsSyncSpy.mockImplementation(
        (p: string) =>
          String(p).endsWith('WBP-0001.md')
          || String(p).endsWith('/jira')
          || String(p) === canonicalPlanPath
          || String(p) === canonicalManifestPath,
      );
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(canonicalManifestPath)] as any);
      // statSync is called by discoverPlanAction's sort — prevent real fs access
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs').promises, 'readFile').mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath === canonicalManifestPath) {
          return JSON.stringify({
            artifactPath: canonicalPlanPath,
            action: 'feature',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
          });
        }
        return JSON.stringify({ action: 'feature', steps: [] });
      });

      const mockOrchestrator = {
        implementer: { execute: jest.fn().mockResolvedValue(undefined) },
        planner: { execute: jest.fn() },
      };
      const module = await Test.createTestingModule({
        providers: [
          IssueImplementCommand,
          { provide: AiService, useValue: {} },
          { provide: IssueTrackerService, useValue: {} },
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

      await cmd.run([], { ticketKey: 'WBP-0001', repos: ['repo-a'] });

      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      const [ticketArg, planArg] = mockOrchestrator.implementer.execute.mock.calls[0];
      expect(ticketArg.ticketKey).toBe('WBP-0001');
      expect(ticketArg.path).toBe(path.join(getWfHomeDir(), 'repo-a', 'jira', 'WBP-0001.md'));
      expect(planArg.action).toBe('feature');
      expect(planArg.path).toBe(canonicalPlanPath);
      expect(mockOrchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          trackerName: 'jira',
          repoDir: '/tmp/consumer-app/repo-a',
        }),
      );
      // planner was never called — plan was loaded from disk
      expect(mockOrchestrator.planner.execute).not.toHaveBeenCalled();
    });
  });

  describe('ticket mode with multiple repos', () => {
    const setupMultiRepoTest = async () => {
      await buildCommand();
      const hash = hashPlanArtifactSources(['WBP-0001']);
      const canonicalPlanPath = path.join(
        getWfHomeDir(), 'repo-a',
        'jira',
        `2026-04-16-${hash}-feature-plan.json`,
      );
      const canonicalManifestPath = buildPlanArtifactManifestPath(canonicalPlanPath);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const existsSyncSpy = jest
        .spyOn(require('fs'), 'existsSync')
        .mockImplementation(
          (p: string) =>
            String(p).endsWith('WBP-0001.md')
            || String(p).endsWith('/jira')
            || String(p) === canonicalPlanPath
            || String(p) === canonicalManifestPath,
        );
      jest.spyOn(require('fs'), 'readdirSync').mockReturnValue([path.basename(canonicalManifestPath)] as any);
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
      jest.spyOn(require('fs').promises, 'readFile').mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
      jest.spyOn(require('fs'), 'readFileSync').mockImplementation((input: any) => {
        const filePath = String(input);
        if (filePath === canonicalManifestPath) {
          return JSON.stringify({
            artifactPath: canonicalPlanPath,
            action: 'feature',
            createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
            format: 'json',
            hash,
            sourceKind: 'ticket',
            sourceName: 'WBP-0001',
            ticketKey: 'WBP-0001',
          });
        }
        return JSON.stringify({ action: 'feature', steps: [] });
      });
      const mockModule = await Test.createTestingModule({
        providers: [
          IssueImplementCommand,
          { provide: AiService, useValue: { getProviderDisplayName: jest.fn().mockReturnValue('OpenAI') } },
          { provide: IssueTrackerService, useValue: {} },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('jira') } },
          {
            provide: LoggerService,
            useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
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
            useValue: { implementer: { execute: jest.fn() }, planner: { execute: jest.fn() } },
          },
        ],
      }).compile();
      const orchestrator = mockModule.get(AgentOrchestrator);
      return { command: mockModule.get(IssueImplementCommand), orchestrator, consoleSpy, existsSyncSpy };
    };

    it('calls implementer.execute per-repo with allowMultiRepoScope when multiple repos are passed', async () => {
      const { command, orchestrator, existsSyncSpy, consoleSpy } = await setupMultiRepoTest();

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a', 'repo-b'] });

      expect(orchestrator.implementer.execute).toHaveBeenCalledTimes(2);
      expect(orchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          repoDir: '/tmp/consumer-app/repo-a',
          additionalRepoDirs: ['/tmp/consumer-app/repo-b'],
          allowMultiRepoScope: true,
          suppressHeader: true,
        }),
      );
      expect(orchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          repoDir: '/tmp/consumer-app/repo-b',
          additionalRepoDirs: ['/tmp/consumer-app/repo-a'],
          allowMultiRepoScope: true,
          suppressHeader: true,
        }),
      );

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('calls implementer.execute once without allowMultiRepoScope for single repo', async () => {
      const { command, orchestrator, existsSyncSpy, consoleSpy } = await setupMultiRepoTest();

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a'] });

      expect(orchestrator.implementer.execute).toHaveBeenCalledTimes(1);
      expect(orchestrator.implementer.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          repoDir: '/tmp/consumer-app/repo-a',
          allowMultiRepoScope: false,
          suppressHeader: false,
        }),
      );

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('stops iterating repos when investigation result is returned', async () => {
      const { command, orchestrator, existsSyncSpy, consoleSpy } = await setupMultiRepoTest();
      (orchestrator.implementer.execute as jest.Mock).mockResolvedValueOnce({ type: 'investigation' });

      await command.run([], { ticketKey: 'WBP-0001', repos: ['repo-a', 'repo-b'] });

      expect(orchestrator.implementer.execute).toHaveBeenCalledTimes(1);

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  it('rejects empty input when neither --ticket-key nor plan-token is provided', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--ticket-key');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects a ticket-key-shaped positional with a migration hint', async () => {
    const command = await buildCommand();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await command.run(['WBP-123'], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = consoleErrorSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('-k');
    expect(output).toContain('WBP-123');

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('accepts a bare plan-token positional without --ticket-key', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    jest
      .spyOn(require('fs'), 'existsSync')
      .mockImplementation((input: string) =>
        String(input).endsWith(path.join('.wf', 'repo-a', 'dark-building-creek-fix.json')),
      );
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
    jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
      JSON.stringify({
        action: 'fix',
        summary: 'Fix',
        steps: ['Step 1'],
        affectedFiles: ['repo-a/src/a.ts'],
        affectedRepositories: ['repo-a'],
      }),
    );

    await command.run(['dark-building-creek-fix.json'], {
      repos: ['repo-a'],
      dryRun: true,
    });

    expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: path.join(getWfHomeDir(), 'repo-a', 'dark-building-creek-fix.json'),
      }),
    );
  });

  describe('filterActiveRepos', () => {
    const buildPlanArtifact = (overrides?: Partial<{ affectedRepositories: string[] }>) => ({
      action: 'fix' as const,
      path: '/tmp/.wf/repo-a/jira/plan.json',
      plan: {
        action: 'fix' as const,
        summary: 'Fix something',
        steps: ['Update a file'],
        estimatedComplexity: 'low' as const,
        affectedFiles: ['repo-a/src/a.ts'],
        affectedRepositories: overrides?.affectedRepositories ?? ['repo-a'],
      },
    });

    it('skips repos not in affectedRepositories', async () => {
      const command = await buildCommand();
      const plan = buildPlanArtifact({ affectedRepositories: ['repo-a'] });
      const result = (command as any).filterActiveRepos(['repo-a', 'repo-b'], plan);
      expect(result).toEqual(['repo-a']);
    });

    it('keeps all repos when affectedRepositories is empty', async () => {
      const command = await buildCommand();
      const plan = buildPlanArtifact({ affectedRepositories: [] });
      const result = (command as any).filterActiveRepos(['repo-a', 'repo-b'], plan);
      expect(result).toEqual(['repo-a', 'repo-b']);
    });

    it('always keeps undefined (cwd mode)', async () => {
      const command = await buildCommand();
      const plan = buildPlanArtifact({ affectedRepositories: ['repo-a'] });
      const result = (command as any).filterActiveRepos([undefined, 'repo-b'], plan);
      expect(result).toEqual([undefined]);
    });

    it('falls back to full list when filtering removes all repos', async () => {
      const command = await buildCommand();
      const plan = buildPlanArtifact({ affectedRepositories: ['repo-c'] });
      const result = (command as any).filterActiveRepos(['repo-a', 'repo-b'], plan);
      expect(result).toEqual(['repo-a', 'repo-b']);
    });
  });

  describe('buildImplementOpts isNewRepo', () => {
    it('sets isNewRepo when repo is in plan newRepositories', async () => {
      const command = await buildCommand();
      const planArtifact: any = {
        plan: {
          newRepositories: ['new-repo'],
        },
      };
      const ctx: any = {
        trackerName: 'jira',
        baseDir: '/tmp',
        trackerDir: '/tmp/.wf',
        customArtifactDir: '/tmp/.wf/custom',
        repos: ['new-repo'],
        ticketKey: undefined,
        resolvedPlanReference: null,
        plan: undefined,
      };

      const result = (command as any).buildImplementOpts('new-repo', ctx, {}, false, undefined, planArtifact);

      expect(result.isNewRepo).toBe(true);
      jest.restoreAllMocks();
    });

    it('does not set isNewRepo for repos absent from newRepositories', async () => {
      const command = await buildCommand();
      const planArtifact: any = {
        plan: {
          newRepositories: ['new-repo'],
        },
      };
      const ctx: any = {
        trackerName: 'jira',
        baseDir: '/tmp',
        trackerDir: '/tmp/.wf',
        customArtifactDir: '/tmp/.wf/custom',
        repos: ['existing-repo'],
        ticketKey: undefined,
        resolvedPlanReference: null,
        plan: undefined,
      };

      const result = (command as any).buildImplementOpts('existing-repo', ctx, {}, false, undefined, planArtifact);

      expect(result.isNewRepo).toBe(false);
      jest.restoreAllMocks();
    });
  });

  describe('filterActiveRepos newRepositories union', () => {
    let command: IssueImplementCommand;

    beforeEach(async () => {
      command = await buildCommand();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('keeps a repo that appears only in newRepositories', () => {
      const planArtifact = {
        plan: {
          affectedRepositories: ['repoA'],
          newRepositories: ['repoB'],
        },
      } as any;

      const result = (command as any).filterActiveRepos([undefined, 'repoA', 'repoB'], planArtifact);

      expect(result).toEqual([undefined, 'repoA', 'repoB']);
    });

    it('keeps repos from both affectedRepositories and newRepositories', () => {
      const planArtifact = {
        plan: {
          affectedRepositories: ['repoA'],
          newRepositories: ['repoB'],
        },
      } as any;

      const result = (command as any).filterActiveRepos(['repoA', 'repoB'], planArtifact);

      expect(result).toEqual(['repoA', 'repoB']);
    });

    it('returns full list when both are empty', () => {
      const planArtifact = {
        plan: {
          affectedRepositories: [],
          newRepositories: [],
        },
      } as any;

      const result = (command as any).filterActiveRepos(['repoA', 'repoB'], planArtifact);

      expect(result).toEqual(['repoA', 'repoB']);
    });
  });

  describe('investigate findings routing', () => {
    it('passes stage=implement when generating investigation findings', async () => {
      const command = await buildCommand();
      const aiService = (command as any).aiService;
      const executeSpy = jest.spyOn(aiService, 'execute').mockResolvedValue({
        content: JSON.stringify({ action: 'investigate', summary: '', findings: [], recommendations: [], conclusion: '' }),
      });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockPlan = {
        action: 'investigate',
        summary: 'check auth',
        steps: ['check'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        affectedRepositories: [],
      };

      await (command as any).generateFindings(mockPlan);

      expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ stage: 'implement' }));
      consoleSpy.mockRestore();
    });
  });

  describe('initializeWfConfig per-repo calls', () => {
    beforeEach(() => {
      (initializeWfConfig as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('calls initializeWfConfig once per active repo in runImplementerLoop', async () => {
      const command = await buildCommand();
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(command as any, 'executeRepoImplementation').mockResolvedValue(false);

      const ctx = {
        trackerName: 'jira',
        baseDir: '/tmp/consumer-app',
        trackerDir: '/tmp/consumer-app/jira',
        customArtifactDir: '/tmp/consumer-app/.wf',
        repos: ['repo-a', 'repo-b'],
        ticketKey: undefined,
        resolvedPlanReference: null,
        plan: undefined,
      };
      const planArtifact: any = {
        action: 'fix',
        plan: { action: 'fix', summary: '', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
      };

      await (command as any).runImplementerLoop(
        { ticketKey: 'WBP-123', content: '#', path: '/tmp/consumer-app/jira/WBP-123.md' },
        planArtifact,
        ctx,
        { silent: true }
      );

      expect(initializeWfConfig).toHaveBeenCalledTimes(2);
      expect(initializeWfConfig).toHaveBeenNthCalledWith(1, '/tmp/consumer-app/repo-a');
      expect(initializeWfConfig).toHaveBeenNthCalledWith(2, '/tmp/consumer-app/repo-b');
    });
  });
});
