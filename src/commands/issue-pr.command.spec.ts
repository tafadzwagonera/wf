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

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((_repo?: string) => '/tmp/consumer-app'),
    resolveArtifactDir: jest.fn((_baseDir: string, platform: string) => `/tmp/consumer-app/${platform}`),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { IssuePrCommand } from './issue-pr.command';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { AiService } from '../integrations/ai/ai.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerFeature } from '../integrations/issue-trackers/issue-tracker-adapter.interface';

const mockCreatePullRequest = jest.fn().mockResolvedValue('https://github.com/owner/repo/pull/1');

const createMockManifest = (action: 'feature' | 'fix' | 'investigate', hash: string) => ({
  artifactPath: `/tmp/consumer-app/github/2026-10-16-${hash}-${action}-plan.json`,
  action,
  createdAt: '2026-10-16T00:00:00.000Z',
  format: 'json',
  hash,
  sourceKind: 'ticket',
  sourceName: 'WBP-2971',
  ticketKey: 'WBP-2971',
  trackerName: 'github',
});

const mockIssueTrackerAdapter = {
  supports: jest.fn(),
  getTrackerName: jest.fn().mockReturnValue('github'),
  createPullRequest: mockCreatePullRequest,
};

const mockIssueTrackerService = {
  getAdapter: jest.fn().mockReturnValue(mockIssueTrackerAdapter),
};

const mockAiService = {
  getProviderDisplayName: jest.fn().mockReturnValue('Anthropic'),
};

const mockLoggerService = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
};

const mockDryRunPreviewService = {
  showHeader: jest.fn(),
  showSummary: jest.fn(),
  showValidationResult: jest.fn(),
  previewApiCall: jest.fn(),
  previewFileRead: jest.fn(),
  previewFileWrite: jest.fn(),
};

const mockGitService = {
  getBranchInfo: jest.fn().mockResolvedValue({ current: 'feature/WBP-2971-my-fix' }),
  isGitRepository: jest.fn().mockResolvedValue(true),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: string) => {
    if (key === 'tracker') return 'github';
    return defaultValue;
  }),
};

async function buildCommand(): Promise<IssuePrCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssuePrCommand,
      { provide: IssueTrackerService, useValue: mockIssueTrackerService },
      { provide: AiService, useValue: mockAiService },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: DryRunPreviewService, useValue: mockDryRunPreviewService },
      { provide: GitService, useValue: mockGitService },
      { provide: ConfigService, useValue: mockConfigService },
    ],
  }).compile();

  return module.get(IssuePrCommand);
}

describe('IssuePrCommand', () => {
  let exitSpy: jest.SpyInstance;
  const mockExistsSync = fs.existsSync as jest.Mock;
  const mockReadFileSync = fs.readFileSync as jest.Mock;
  const mockReaddirSync = fs.readdirSync as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe('run()', () => {
    describe('--dry-run', () => {
      it('calls dryRunPreview.showHeader() and does NOT call createPullRequest()', async () => {
        const command = await buildCommand();

        await command.run(['WBP-2971'], { dryRun: true });

        expect(mockDryRunPreviewService.showHeader).toHaveBeenCalledWith('issue:pr', 'WBP-2971');
        expect(mockCreatePullRequest).not.toHaveBeenCalled();
      });
    });

    describe('unsupported platform', () => {
      it('exits with error message when platform does not support CREATE_PULL_REQUEST', async () => {
        mockIssueTrackerAdapter.supports.mockImplementation(
          (feature: IssueTrackerFeature) => feature !== IssueTrackerFeature.CREATE_PULL_REQUEST,
        );

        const command = await buildCommand();

        // process.exit(1) mock throws; ErrorHandler catches and calls process.exit(1) again
        // The test simply asserts process.exit was called with 1
        try {
          await command.run(['WBP-2971'], {});
        } catch {
          // swallow the re-thrown mock error
        }

        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    });

    describe('no plan artifact found', () => {
      it('exits with error when plan artifact does not exist', async () => {
        mockIssueTrackerAdapter.supports.mockReturnValue(true);
        mockExistsSync.mockReturnValue(false);

        const command = await buildCommand();

        try {
          await command.run(['WBP-2971'], { action: 'fix' });
        } catch {
          // swallow the re-thrown mock error
        }

        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    });

    describe('--action validation', () => {
      it('rejects values outside feature|fix|investigate at option parsing', async () => {
        const command = await buildCommand();

        expect(() => command.parseAction('bogus')).toThrow(
          'Invalid action: bogus. Valid actions: feature, fix, investigate',
        );
        expect(command.parseAction('fix')).toBe('fix');
      });
    });

    describe('successful PR creation', () => {
      const mockFixManifest = createMockManifest('fix', 'abc123de');
      const planContent = JSON.stringify({
        action: 'fix',
        summary: 'Fix the bug',
        steps: ['Step 1'],
      });

      const mockManifestOnDisk = (manifests: ReturnType<typeof createMockManifest>[]) => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(
          manifests.map(m => {
            const artifactFilename = m.artifactPath.slice(m.artifactPath.lastIndexOf('/') + 1);
            return `${artifactFilename.replace(/\.json$/, '')}.sources.json`;
          }),
        );
        mockReadFileSync.mockImplementation((p: any) => {
          const requested = String(p);
          if (requested.endsWith('.sources.json')) {
            const manifest = manifests.find(m => requested.startsWith(m.artifactPath.replace(/\.json$/, '')));
            return JSON.stringify(manifest);
          }
          return planContent;
        });
      };

      it('resolves the plan via its manifest and logs the PR URL', async () => {
        mockIssueTrackerAdapter.supports.mockReturnValue(true);
        mockManifestOnDisk([mockFixManifest]);

        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const command = await buildCommand();

        await command.run(['WBP-2971'], { action: 'fix', base: 'main' });

        expect(mockCreatePullRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            title: expect.stringContaining('WBP-2971'),
            base: 'main',
            head: expect.any(String),
          }),
        );
        expect(mockReadFileSync).toHaveBeenCalledWith(mockFixManifest.artifactPath, 'utf-8');

        const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
        const prUrlLogged = logCalls.some(line => line.includes('https://github.com/owner/repo/pull/1'));
        expect(prUrlLogged).toBe(true);

        consoleSpy.mockRestore();
      });

      it('resolves a single matching plan when no action is given', async () => {
        mockIssueTrackerAdapter.supports.mockReturnValue(true);
        mockManifestOnDisk([mockFixManifest]);

        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const command = await buildCommand();

        await command.run(['WBP-2971'], { base: 'main' });

        expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ base: 'main' }));
        expect(mockReadFileSync).toHaveBeenCalledWith(mockFixManifest.artifactPath, 'utf-8');

        consoleSpy.mockRestore();
      });

      it('exits with error when multiple plans match and no action narrows the search', async () => {
        mockIssueTrackerAdapter.supports.mockReturnValue(true);
        mockManifestOnDisk([mockFixManifest, createMockManifest('feature', 'def456ab')]);

        const command = await buildCommand();

        try {
          await command.run(['WBP-2971'], {});
        } catch {
          // swallow the re-thrown mock error
        }

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockCreatePullRequest).not.toHaveBeenCalled();
      });
    });
  });
});
