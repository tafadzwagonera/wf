/**
 * Manual Test: issue:plan generated plan validation
 *
 * Run: yarn test:manual -- test-issue-plan-validation
 *
 * Verifies:
 *   1. Ticket-mode planning passes affectedRepositories into plan generation
 *   2. Placeholder repository metadata is rejected before artifact write
 *   3. Expected-failure verification commands must be wrapped so success exits 0
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssuePlanCommand } from '../../src/commands/issue-plan.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';
import { FetchStageService } from '../../src/workflows/stages/fetch-stage.service';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import * as fs from 'fs';
import * as path from 'path';

type AsyncMock<TArgs extends unknown[], TResult> = ((...args: TArgs) => Promise<TResult>) & {
  calls: TArgs[];
  mockResolvedValue: (value: TResult) => void;
};

const createAsyncMock = <TArgs extends unknown[], TResult>(): AsyncMock<TArgs, TResult> => {
  let implementation = async (..._args: TArgs): Promise<TResult> => undefined as TResult;
  const mock = (async (...args: TArgs): Promise<TResult> => {
    mock.calls.push(args);
    return implementation(...args);
  }) as AsyncMock<TArgs, TResult>;

  mock.calls = [];
  mock.mockResolvedValue = (value: TResult): void => {
    implementation = async (): Promise<TResult> => value;
  };

  return mock;
};

const createLoggerStub = (): LoggerService => {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
  } as unknown as LoggerService;
};

const createDryRunPreviewStub = (): DryRunPreviewService =>
  ({
    showHeader: (): void => undefined,
    showSummary: (): void => undefined,
    showValidationResult: (): void => undefined,
    previewApiCall: (): void => undefined,
    previewFileRead: (): void => undefined,
    previewFileWrite: (): void => undefined,
  }) as unknown as DryRunPreviewService;

let passed = 0;
let failed = 0;
const repoName = path.basename(process.cwd());

const pass = (message: string): void => {
  console.log(`  ✓ ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed += 1;
};

const buildCommand = async (): Promise<{
  command: IssuePlanCommand;
  fetchArtifact: AsyncMock<
    [string, { trackerName: string; repo: string; baseDir: string }],
    { ticketKey: string; content: string; path: string }
  >;
  generatePlan: AsyncMock<
    [string, { action: string; ticketKey?: string; affectedRepositories?: string[] }],
    Record<string, unknown>
  >;
}> => {
  const fetchArtifact = createAsyncMock<
    [string, { trackerName: string; repo: string; baseDir: string }],
    { ticketKey: string; content: string; path: string }
  >();
  const loadArtifact = createAsyncMock<
    [string, string, string],
    { ticketKey: string; content: string; path: string }
  >();
  const generatePlan = createAsyncMock<
    [string, { action: string; ticketKey?: string; affectedRepositories?: string[] }],
    Record<string, unknown>
  >();

  const module = await Test.createTestingModule({
    providers: [
      IssuePlanCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: () => 'OpenAI',
        },
      },
      { provide: IssueTrackerService, useValue: {} },
      {
        provide: FetchStageService,
        useValue: {
          fetchArtifact,
          loadArtifact,
        },
      },
      {
        provide: PlanStageService,
        useValue: {
          generatePlan,
        },
      },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, defaultValue?: string): string =>
            key === 'platforms.primary' ? 'jira' : (defaultValue ?? 'jira'),
        },
      },
      { provide: LoggerService, useValue: createLoggerStub() },
      { provide: DryRunPreviewService, useValue: createDryRunPreviewStub() },
    ],
  }).compile();

  return {
    command: module.get(IssuePlanCommand),
    fetchArtifact,
    generatePlan,
  };
};

const captureWriteFileCalls = async (runCommand: () => Promise<void>): Promise<{ callCount: number }> => {
  const originalWriteFile = fs.promises.writeFile;
  let callCount = 0;

  fs.promises.writeFile = (async (...args: unknown[]) => {
    callCount += 1;
    return undefined;
  }) as typeof fs.promises.writeFile;

  try {
    await runCommand();
  } finally {
    fs.promises.writeFile = originalWriteFile;
  }

  return { callCount };
};

const captureCommandOutput = async (
  runCommand: () => Promise<void>
): Promise<{ output: string; exitCodes: number[] }> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitCodes: number[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit.bind(process);

  (process.stdout.write as unknown as (...args: unknown[]) => boolean) = (chunk: unknown, ...args: unknown[]) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return originalStdoutWrite(chunk as never, ...(args as []));
  };
  (process.stderr.write as unknown as (...args: unknown[]) => boolean) = (chunk: unknown, ...args: unknown[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return originalStderrWrite(chunk as never, ...(args as []));
  };
  (process.exit as unknown as (code?: number) => never) = ((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`process.exit(${code ?? 0})`);
  }) as (code?: number) => never;

  try {
    await runCommand();
  } catch {
    // Swallow command failures so the manual test can assert on output.
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  return {
    output: stdoutChunks.join('') + stderrChunks.join(''),
    exitCodes,
  };
};

const main = async (): Promise<void> => {
  console.log('\n🧪 Test 1: valid plan passes repo hints through ticket-mode planning\n');
  {
    const { command, fetchArtifact, generatePlan } = await buildCommand();

    fetchArtifact.mockResolvedValue({
      ticketKey: 'PLAN-1',
      content: '# PLAN-1: Validate plan metadata\n',
      path: `/tmp/.wf/${repoName}/jira/PLAN-1.md`,
    });
    generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Valid plan',
      estimatedComplexity: 'low',
      steps: ['Update one file'],
      affectedFiles: [`${repoName}/src/example.ts`],
      repositoriesAffected: [repoName],
    } as never);

    const { callCount } = await captureWriteFileCalls(() =>
      command.run(['PLAN-1'], {
        action: 'fix',
        repos: [repoName],
      })
    );

    const [, planOptions] = generatePlan.calls[0] ?? [];
    if (
      planOptions?.affectedRepositories?.length === 1 &&
      planOptions.affectedRepositories[0] === repoName &&
      callCount === 1
    ) {
      pass('Ticket-mode planning forwards repo hints and persists a valid plan');
    } else {
      fail('Ticket-mode planning did not forward repo hints correctly', JSON.stringify(planOptions));
    }
  }

  console.log('\n🧪 Test 2: placeholder repository metadata is rejected before write\n');
  {
    const { command, fetchArtifact, generatePlan } = await buildCommand();

    fetchArtifact.mockResolvedValue({
      ticketKey: 'PLAN-2',
      content: '# PLAN-2: Reject placeholder metadata\n',
      path: `/tmp/.wf/${repoName}/jira/PLAN-2.md`,
    });
    generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Invalid plan',
      estimatedComplexity: 'low',
      steps: ['Update one file'],
      affectedFiles: ['repo-name/src/example.ts'],
      repositoriesAffected: ['repo-name'],
    } as never);

    const originalWriteFile = fs.promises.writeFile;
    let writeCallCount = 0;
    fs.promises.writeFile = (async () => {
      writeCallCount += 1;
      return undefined;
    }) as typeof fs.promises.writeFile;

    const { output, exitCodes } = await captureCommandOutput(async () => {
      try {
        await command.run(['PLAN-2'], {
          action: 'fix',
          repos: [repoName],
        });
      } finally {
        fs.promises.writeFile = originalWriteFile;
      }
    });

    if (writeCallCount === 0 && exitCodes.includes(1) && output.includes('placeholder repository metadata')) {
      pass('Placeholder metadata fails fast before artifact write');
    } else {
      fail('Placeholder metadata was not rejected as expected', output);
    }
  }

  console.log('\n🧪 Test 3: non-asserted expected-failure verification commands are rejected\n');
  {
    const { command, fetchArtifact, generatePlan } = await buildCommand();

    fetchArtifact.mockResolvedValue({
      ticketKey: 'PLAN-3',
      content: '# PLAN-3: Reject invalid verification commands\n',
      path: `/tmp/.wf/${repoName}/jira/PLAN-3.md`,
    });
    generatePlan.mockResolvedValue({
      action: 'fix',
      summary: 'Invalid verification plan',
      estimatedComplexity: 'low',
      steps: ['Update one file'],
      affectedFiles: [`${repoName}/src/example.ts`],
      repositoriesAffected: [repoName],
      verification: {
        targeted: [
          {
            id: 'criteria-rejected',
            run: 'yarn start issue:review --criteria criteria.txt',
            policy: 'enforced',
            reason: 'Expected failure for non-Markdown criteria',
          },
        ],
      },
    } as never);

    const originalWriteFile = fs.promises.writeFile;
    let writeCallCount = 0;
    fs.promises.writeFile = (async () => {
      writeCallCount += 1;
      return undefined;
    }) as typeof fs.promises.writeFile;

    const { output, exitCodes } = await captureCommandOutput(async () => {
      try {
        await command.run(['PLAN-3'], {
          action: 'fix',
          repos: [repoName],
        });
      } finally {
        fs.promises.writeFile = originalWriteFile;
      }
    });

    if (
      writeCallCount === 0 &&
      exitCodes.includes(1) &&
      output.includes('must assert expected failure inside the command')
    ) {
      pass('Expected-failure verification commands must be wrapped');
    } else {
      fail('Invalid verification command was not rejected as expected', output);
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
};

main();
