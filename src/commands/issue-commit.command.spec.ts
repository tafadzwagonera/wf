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

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) => (repo ? `/tmp/repos/${repo}` : '/tmp/current-app')),
  };
});

// withRepoLock is exercised for real in repo-lock.spec.ts; mocked here as a passthrough so
// command specs don't take a real filesystem lock on the shared literal '/tmp/current-app'
// path, which could collide across parallel Jest workers.
jest.mock('../common/utils/repo-lock', () => ({
  withRepoLock: jest.fn((_repoDir: string, fn: () => Promise<unknown>) => fn()),
}));

jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

jest.mock('../common/utils/resolve-commit-scope-summary', () => ({
  resolveCommitScopeSummary: jest.fn().mockReturnValue(null),
  resolveFreshCommitDescription: jest.fn().mockReturnValue(null),
}));

jest.mock('../common/logger/log-file-writer', () => ({ appendToLogFile: jest.fn() }));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueCommitCommand } from './issue-commit.command';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { LoggerService } from '../common/logger/logger.service';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';
import inquirer from 'inquirer';
import { CommitDescriptionStageService } from '../workflows/stages/commit-description-stage.service';
import { resolveCommitScopeSummary, resolveFreshCommitDescription } from '../common/utils/resolve-commit-scope-summary';
import { resolveCustomReviewArtifactPath, resolveReviewArtifactPath } from '../common/utils/resolve-review-summary';
import { appendToLogFile } from '../common/logger/log-file-writer';
import {
  buildPlanArtifactManifest, hashPlanArtifactSources, writePlanArtifactManifest,
} from '../common/utils/plan-artifact';
import { OptionMeta } from 'nest-commander/src/constants';

const setInteractiveSession = (isTTY: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
};

const mockGitService = {
  isGitRepository: jest.fn().mockResolvedValue(true),
  getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
  commit: jest.fn().mockResolvedValue('abc123'),
  getBranchInfo: jest.fn().mockResolvedValue({
    current: 'feature/WBP-123-change',
  }),
};

const mockAiService = {
  getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
  getProviderEndpoint: jest.fn().mockReturnValue('/chat/completions'),
};

async function buildCommand(): Promise<{
  command: IssueCommitCommand;
  commitStageService: jest.Mocked<CommitStageService>;
  commitDescriptionStageService: jest.Mocked<CommitDescriptionStageService>;
}> {
  const module = await Test.createTestingModule({
    providers: [
      IssueCommitCommand,
      { provide: GitService, useValue: mockGitService },
      { provide: AiService, useValue: mockAiService },
      {
        provide: CommitStageService,
        useValue: {
          generateCommitMessage: jest.fn().mockResolvedValue('WBP-123: ship it'),
        },
      },
      {
        provide: CommitDescriptionStageService,
        useValue: { generate: jest.fn().mockResolvedValue(null) },
      },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue) },
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
          previewGitOperation: jest.fn(),
        },
      },
    ],
  }).compile();

  return {
    command: module.get(IssueCommitCommand),
    commitStageService: module.get(CommitStageService),
    commitDescriptionStageService: module.get(CommitDescriptionStageService),
  };
}

describe('IssueCommitCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue('/tmp/current-app');
    (inquirer.prompt as unknown as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ticket key mismatch against branch name', () => {
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
    });

    it('does not warn or prompt when --ticket-key matches the branch ticket key', async () => {
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-123', message: 'ship it' });

      expect(inquirer.prompt).not.toHaveBeenCalled();
      const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(allOutput).not.toContain('does not match');
      expect(mockGitService.commit).toHaveBeenCalledWith({ message: 'WBP-123: ship it', cwd: '/tmp/current-app' });

      consoleSpy.mockRestore();
    });

    it('throws a ValidationError on mismatch when the session is non-interactive', async () => {
      setInteractiveSession(false);
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      await expect(
        command.run([], { ticketKey: 'WBP-999', message: 'ship it' })
      ).rejects.toThrow('process.exit');

      const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(allOutput).toContain("'WBP-999'");
      expect(allOutput).toContain("'WBP-123'");
      expect(mockGitService.commit).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('prompts and uses the branch ticket key when the user selects it interactively', async () => {
      setInteractiveSession(true);
      (inquirer.prompt as unknown as jest.Mock).mockResolvedValueOnce({ selectedKey: 'WBP-123' });
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-999', message: 'ship it' });

      expect(inquirer.prompt).toHaveBeenCalled();
      expect(mockGitService.commit).toHaveBeenCalledWith({ message: 'WBP-123: ship it', cwd: '/tmp/current-app' });

      consoleSpy.mockRestore();
    });

    it('prompts and keeps the explicit --ticket-key when the user selects it interactively', async () => {
      setInteractiveSession(true);
      (inquirer.prompt as unknown as jest.Mock).mockResolvedValueOnce({ selectedKey: 'WBP-999' });
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-999', message: 'ship it' });

      expect(inquirer.prompt).toHaveBeenCalled();
      expect(mockGitService.commit).toHaveBeenCalledWith({ message: 'WBP-999: ship it', cwd: '/tmp/current-app' });

      consoleSpy.mockRestore();
    });

    it('does not compare or warn when the branch has no parseable ticket key', async () => {
      mockGitService.getBranchInfo.mockResolvedValueOnce({ current: 'master' });
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-999', message: 'ship it' });

      expect(inquirer.prompt).not.toHaveBeenCalled();
      const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(allOutput).not.toContain('does not match');
      expect(mockGitService.commit).toHaveBeenCalledWith({ message: 'WBP-999: ship it', cwd: '/tmp/current-app' });

      consoleSpy.mockRestore();
    });

    it('does not treat a lowercase-prefixed branch as a mismatch when the embedded key matches -k', async () => {
      mockGitService.getBranchInfo.mockResolvedValueOnce({ current: 'fixWBP-4061-show-review-title' });
      setInteractiveSession(false);
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-4061', message: 'ship it' });

      expect(inquirer.prompt).not.toHaveBeenCalled();
      const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(allOutput).not.toContain('does not match');
      expect(mockGitService.commit).toHaveBeenCalledWith({ message: 'WBP-4061: ship it', cwd: '/tmp/current-app' });

      consoleSpy.mockRestore();
    });

    it('warns without prompting or throwing during --dry-run on mismatch', async () => {
      setInteractiveSession(false);
      const { command } = await buildCommand();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await command.run([], { ticketKey: 'WBP-999', dryRun: true });

      expect(inquirer.prompt).not.toHaveBeenCalled();
      const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(allOutput).toContain("'WBP-999'");
      expect(allOutput).toContain("'WBP-123'");
      expect(allOutput).toContain('dry-run');

      consoleSpy.mockRestore();
    });
  });

  it('uses process.cwd() as the git base when --repos is absent', async () => {
    const { command } = await buildCommand();

    await command.run([], { ticketKey: 'WBP-123', message: 'ship it' });

    expect(mockGitService.isGitRepository).toHaveBeenCalledWith('/tmp/current-app');
    expect(mockGitService.getDiff).toHaveBeenCalledWith(true, '/tmp/current-app');
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/current-app',
    });
  });

  it('runs the commit under a repo lock scoped to the resolved git base', async () => {
    const { withRepoLock } = jest.requireMock('../common/utils/repo-lock');
    const { command } = await buildCommand();

    await command.run([], { ticketKey: 'WBP-123', message: 'ship it' });

    expect(withRepoLock).toHaveBeenCalledWith('/tmp/current-app', expect.any(Function));
  });

  it('uses only the first resolved repo and warns when multiple repos are provided', async () => {
    const { command } = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await command.run([], {
      ticketKey: 'WBP-123',
      message: 'ship it',
      repos: ['repo-a', 'repo-b'],
    });

    expect(mockGitService.isGitRepository).toHaveBeenCalledWith('/tmp/repos/repo-a');
    expect(mockGitService.getDiff).toHaveBeenCalledWith(true, '/tmp/repos/repo-a');
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/repos/repo-a',
    });
    expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('Only the first repository'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('delegates AI commit message generation to CommitStageService', async () => {
    const { command, commitStageService } = await buildCommand();

    await command.run([], { ticketKey: 'WBP-123' });

    expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      conventional: undefined,
    });
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/current-app',
    });
  });

  it('suppresses the header when --silent is passed', async () => {
    const { command } = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await command.run([], { ticketKey: 'WBP-123', message: 'ship it', silent: true });

    const allOutput = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(allOutput).not.toContain('Create a git commit with an AI-generated message.');
    expect(allOutput).not.toContain('Examples:');

    consoleSpy.mockRestore();
  });

  describe('--source artifact locator', () => {
    const priorWfHome = process.env.WF_HOME;
    const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-commit-review-'));
    process.env.WF_HOME = wfHome;
    const appDir = path.join(wfHome, 'current-app');
    const trackerDir = path.join(appDir, 'jira');

    const touchReview = (dir: string, name: string, mtimeInSecs: number): string => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, 'x', 'utf-8');
      fs.utimesSync(filePath, mtimeInSecs, mtimeInSecs);
      return filePath;
    };

    beforeEach(() => {
      fs.mkdirSync(trackerDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(appDir, { recursive: true, force: true });
    });

    afterAll(() => {
      if (priorWfHome === undefined) delete process.env.WF_HOME;
      else process.env.WF_HOME = priorWfHome;
      fs.rmSync(wfHome, { recursive: true, force: true });
    });

    const trackerPath = resolveReviewArtifactPath('/tmp/current-app', 'jira', 'WBP-1');
    const customPath = resolveCustomReviewArtifactPath('/tmp/current-app', 'plan');
    const stagedDiff = 'diff --git a/file b/file';

    const trackerYamlPath = resolveReviewArtifactPath('/tmp/current-app', 'jira', 'WBP-1', 'yaml');

    const candidatePaths = [
      trackerPath,
      trackerYamlPath,
      customPath,
      resolveReviewArtifactPath('/tmp/current-app', 'jira', 'plan'),
      resolveCustomReviewArtifactPath('/tmp/current-app', 'WBP-1'),
    ];

    const mockExistingFiles = (...existing: string[]): void => {
      const realExistsSync = jest.requireActual('fs').existsSync;
      jest.spyOn(require('fs'), 'existsSync').mockImplementation((target: unknown) =>
        candidatePaths.includes(String(target)) ? existing.includes(String(target)) : realExistsSync(target));
    };

    it('resolves the tracker-dir review path first for --source <ticket>', async () => {
      mockExistingFiles(trackerPath, resolveCustomReviewArtifactPath('/tmp/current-app', 'WBP-1'));
      const { command } = await buildCommand();

      await command.run([], { source: 'WBP-1', tracker: 'jira', message: undefined });

      expect(resolveCommitScopeSummary).toHaveBeenCalledWith(expect.objectContaining({
        reviewArtifactPath: trackerPath, stagedDiff,
      }));
    });

    it('resolves the custom-dir review path for --source plan.md when the tracker path is missing', async () => {
      mockExistingFiles(customPath);
      const { command } = await buildCommand();

      await command.run([], { source: 'plan.md', tracker: 'jira' });

      expect(resolveCommitScopeSummary).toHaveBeenCalledWith(
        expect.objectContaining({ reviewArtifactPath: customPath })
      );
    });

    it('resolves a review artifact cached in yaml format for --source <ticket>', async () => {
      mockExistingFiles(trackerYamlPath);
      const { command } = await buildCommand();

      await command.run([], { source: 'WBP-1', tracker: 'jira', message: undefined });

      expect(resolveCommitScopeSummary).toHaveBeenCalledWith(
        expect.objectContaining({ reviewArtifactPath: trackerYamlPath })
      );
    });

    it.each(['plan.json', 'plan.yaml', 'plan.yml'])(
      'resolves the custom-dir review path for --source %s',
      async source => {
        mockExistingFiles(customPath);
        const { command } = await buildCommand();

        await command.run([], { source, tracker: 'jira' });

        expect(resolveCommitScopeSummary).toHaveBeenCalledWith(
          expect.objectContaining({ reviewArtifactPath: customPath })
        );
      }
    );

    it('resolves a date-prefixed custom-dir artifact for a bare --source token', async () => {
      const dated = touchReview(appDir, '2026-10-20-reviewer-country-filter-review.md', 1000);
      const { command } = await buildCommand();

      await command.run([], { source: 'reviewer-country-filter', tracker: 'jira' });

      expect(resolveCommitScopeSummary).toHaveBeenCalledWith(expect.objectContaining({ reviewArtifactPath: dated }));
    });

    it('uses the newest of several date-prefixed matches and warns naming both paths', async () => {
      const older = touchReview(appDir, '2026-10-18-plan-review.md', 1000);
      const newer = touchReview(trackerDir, '2026-10-20-plan-review.md', 2000);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { command } = await buildCommand();

      await command.run([], { source: 'plan', tracker: 'jira' });

      expect(resolveCommitScopeSummary).toHaveBeenCalledWith(expect.objectContaining({ reviewArtifactPath: newer }));
      const warning = consoleSpy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes('matched 2 review artifacts'));
      expect(warning).toContain(newer);
      expect(warning).toContain(older);
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.any(String), 'issue-commit');
    });

    it('suppresses the ambiguity console line under --silent but still logs', async () => {
      touchReview(appDir, '2026-10-18-plan-review.md', 1000);
      touchReview(trackerDir, '2026-10-20-plan-review.md', 2000);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { command } = await buildCommand();

      await command.run([], { source: 'plan', tracker: 'jira', silent: true });

      expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('matched 2'))).toBe(false);
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.any(String), 'issue-commit');
    });

    describe('manifest-based resolution', () => {
      const sourceName = '2026-10-19-reviewer-country-filter';

      const writeCustomManifest = (planName: string, customArtifactName = sourceName): string => {
        const planPath = path.join(appDir, planName);
        fs.writeFileSync(planPath, '# plan', 'utf-8');
        const manifest = buildPlanArtifactManifest({
          artifactPath: planPath, action: 'fix', format: 'md', hash: hashPlanArtifactSources([sourceName]),
          sourceName, sourceKind: 'custom', createdAt: new Date('2026-10-19T00:00:00.000Z'),
        });
        writePlanArtifactManifest({ ...manifest, customArtifactName });
        return planPath;
      };

      it('resolves the review beside a hashed plan through the full manifest name', async () => {
        const hash = hashPlanArtifactSources([sourceName]);
        writeCustomManifest(`2026-10-19-${hash}-fix-plan.md`);
        const planReview = touchReview(appDir, `2026-10-19-${hash}-fix-plan-review.md`, 1000);
        touchReview(trackerDir, `2026-10-21-${sourceName}-review.md`, 2000);
        const { command } = await buildCommand();

        await command.run([], { source: sourceName, tracker: 'jira', silent: true });

        expect(resolveCommitScopeSummary).toHaveBeenCalledWith(
          expect.objectContaining({ reviewArtifactPath: planReview })
        );
        expect(appendToLogFile).toHaveBeenCalledWith('INFO', expect.stringContaining('manifest'), 'issue-commit');
      });

      it('resolves the custom review path of the manifest sourceName for a customArtifactName token', async () => {
        writeCustomManifest(`2026-10-19-${hashPlanArtifactSources([sourceName])}-fix-plan.md`, 'alias-token');
        const sourceReview = touchReview(appDir, `${sourceName}-review.md`, 1000);
        expect(sourceReview).toBe(resolveCustomReviewArtifactPath('/tmp/current-app', sourceName));
        const { command } = await buildCommand();

        await command.run([], { source: 'alias-token', tracker: 'jira', silent: true });

        expect(resolveCommitScopeSummary).toHaveBeenCalledWith(
          expect.objectContaining({ reviewArtifactPath: sourceReview })
        );
        expect(appendToLogFile).toHaveBeenCalledWith('INFO', expect.stringContaining('manifest'), 'issue-commit');
      });

      it('warns and falls back to the date-prefixed scan when two manifests share the token', async () => {
        writeCustomManifest(`2026-10-18-${sourceName}.md`, 'shared-name');
        writeCustomManifest(`2026-10-19-${sourceName}-v2.md`, 'shared-name');
        const dated = touchReview(appDir, '2026-10-20-shared-name-review.md', 1000);
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const { command } = await buildCommand();

        await command.run([], { source: 'shared-name', tracker: 'jira' });

        expect(appendToLogFile).toHaveBeenCalledWith(
          'WARN', expect.stringContaining('Multiple plan artifacts found'), 'issue-commit'
        );
        expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('Multiple plan artifacts found')))
          .toBe(true);
        expect(resolveCommitScopeSummary).toHaveBeenCalledWith(expect.objectContaining({ reviewArtifactPath: dated }));
      });

      it('suppresses the manifest ambiguity console line under --silent but still logs', async () => {
        writeCustomManifest(`2026-10-18-${sourceName}.md`, 'shared-name');
        writeCustomManifest(`2026-10-19-${sourceName}-v2.md`, 'shared-name');
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const { command } = await buildCommand();

        await command.run([], { source: 'shared-name', tracker: 'jira', silent: true });

        expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('Multiple plan artifacts found')))
          .toBe(false);
        expect(appendToLogFile).toHaveBeenCalledWith(
          'WARN', expect.stringContaining('Multiple plan artifacts found'), 'issue-commit'
        );
      });
    });

    it('warns, logs, and still generates inline when no review artifact exists', async () => {
      mockExistingFiles();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { command, commitDescriptionStageService } = await buildCommand();

      await command.run([], { source: 'plan.md', tracker: 'jira' });

      expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('plan.md'))).toBe(true);
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('plan.md'), 'issue-commit');
      expect(commitDescriptionStageService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ diff: stagedDiff })
      );
    });

    it('suppresses the missing-artifact console line under --silent but still logs', async () => {
      mockExistingFiles();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { command } = await buildCommand();

      await command.run([], { source: 'plan.md', tracker: 'jira', silent: true });

      expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('plan.md'))).toBe(false);
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('plan.md'), 'issue-commit');
    });
  });

  describe('inline commit description generation', () => {
    const stagedDiff = 'diff --git a/file b/file';

    it('does not generate when a fresh description record exists', async () => {
      (resolveFreshCommitDescription as jest.Mock).mockReturnValueOnce('D (change nature: fix)');
      (resolveCommitScopeSummary as jest.Mock).mockReturnValueOnce('D (change nature: fix)');
      const { command, commitDescriptionStageService, commitStageService } = await buildCommand();

      await command.run([], { ticketKey: 'WBP-123', tracker: 'jira' });

      expect(commitDescriptionStageService.generate).not.toHaveBeenCalled();
      expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ scopeSummary: 'D (change nature: fix)' })
      );
    });

    it('generates and uses the rendered description when no fresh record exists', async () => {
      const { command, commitDescriptionStageService, commitStageService } = await buildCommand();
      commitDescriptionStageService.generate.mockResolvedValueOnce({ nature: 'fix', description: 'D' });

      await command.run([], { ticketKey: 'WBP-123', tracker: 'jira' });

      expect(commitDescriptionStageService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ diff: stagedDiff, stage: 'commit' })
      );
      expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ scopeSummary: 'D (change nature: fix)' })
      );
    });

    it('falls back to the prose-tier summary when generation returns null', async () => {
      (resolveCommitScopeSummary as jest.Mock).mockReturnValueOnce('Review prose summary');
      const { command, commitDescriptionStageService, commitStageService } = await buildCommand();

      await command.run([], { ticketKey: 'WBP-123', tracker: 'jira' });

      expect(commitDescriptionStageService.generate).toHaveBeenCalledTimes(1);
      expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ scopeSummary: 'Review prose summary' })
      );
    });

    it('skips description lookup and generation when --message is provided', async () => {
      const { command, commitDescriptionStageService } = await buildCommand();

      await command.run([], { ticketKey: 'WBP-123', message: 'manual' });

      expect(commitDescriptionStageService.generate).not.toHaveBeenCalled();
    });
  });

  describe('--conventional flag', () => {
    it('registers only the long form with no -c alias', () => {
      const meta = Reflect.getMetadata(OptionMeta, IssueCommitCommand.prototype.parseConventional);

      expect(meta.flags).toBe('--conventional');
    });
  });
});
