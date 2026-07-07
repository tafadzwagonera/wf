/**
 * Manual Test: issue:plan generated plan validation
 *
 * Run: yarn test:manual -- test-issue-plan-validation
 *
 * Verifies:
 *   1. Ticket-mode planning passes affectedRepositories into plan generation
 *   2. Placeholder repository metadata is rejected before artifact write
 *   3. Expected-failure verification commands must be wrapped so success exits 0
 *   4. Retry feedback markers are wired into prompt-building code paths
 *   5. Persisted plans must satisfy semantic quality gates
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
import * as planArtifactUtils from '../../src/shared/utils/plan-artifact';
import * as fs from 'fs';
import * as path from 'path';

type AsyncMock<TArgs extends unknown[], TResult> = ((...args: TArgs) => Promise<TResult>) & {
  calls: TArgs[];
  mockResolvedValue: (value: TResult) => void;
  mockResolvedValueOnce: (value: TResult) => void;
  mockImplementation: (fn: (...args: TArgs) => Promise<TResult>) => void;
};

const createAsyncMock = <TArgs extends unknown[], TResult>(): AsyncMock<TArgs, TResult> => {
  const queuedResults: TResult[] = [];
  let implementation = async (..._args: TArgs): Promise<TResult> => undefined as TResult;
  const mock = (async (...args: TArgs): Promise<TResult> => {
    mock.calls.push(args);
    const queuedResult = queuedResults.shift();
    if (queuedResult !== undefined) {
      return queuedResult;
    }
    return implementation(...args);
  }) as AsyncMock<TArgs, TResult>;

  mock.calls = [];
  mock.mockResolvedValue = (value: TResult): void => {
    implementation = async (): Promise<TResult> => value;
  };
  mock.mockResolvedValueOnce = (value: TResult): void => {
    queuedResults.push(value);
  };
  mock.mockImplementation = (fn: (...args: TArgs) => Promise<TResult>): void => {
    implementation = fn;
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
const mutablePlanArtifactUtils = planArtifactUtils as {
  writePlanArtifactManifest: typeof planArtifactUtils.writePlanArtifactManifest;
};

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
    [string, { action: string; ticketKey?: string; affectedRepositories?: string[]; planQualityFeedback?: string[] }],
    { plan: Record<string, unknown> }
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
    [string, { action: string; ticketKey?: string; affectedRepositories?: string[]; planQualityFeedback?: string[] }],
    { plan: Record<string, unknown> }
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

const captureArtifactWrites = async (
  runCommand: () => Promise<void>
): Promise<{ artifactWriteCallCount: number; manifestWriteCallCount: number; error?: unknown }> => {
  const originalWriteFile = fs.promises.writeFile;
  const originalWritePlanArtifactManifest = mutablePlanArtifactUtils.writePlanArtifactManifest;
  let artifactWriteCallCount = 0;
  let manifestWriteCallCount = 0;
  let error: unknown;

  fs.promises.writeFile = (async (...args: unknown[]) => {
    artifactWriteCallCount += 1;
    return undefined;
  }) as typeof fs.promises.writeFile;
  mutablePlanArtifactUtils.writePlanArtifactManifest = ((..._args: unknown[]) => {
    manifestWriteCallCount += 1;
    return '/tmp/mock-plan-manifest.json';
  }) as typeof planArtifactUtils.writePlanArtifactManifest;

  try {
    await runCommand();
  } catch (caughtError) {
    error = caughtError;
  } finally {
    fs.promises.writeFile = originalWriteFile;
    mutablePlanArtifactUtils.writePlanArtifactManifest = originalWritePlanArtifactManifest;
  }

  return { artifactWriteCallCount, manifestWriteCallCount, error };
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
      plan: {
        action: 'fix',
        summary: 'Valid plan',
        estimatedComplexity: 'low',
        steps: ['Update one file'],
        affectedFiles: [`${repoName}/src/example.ts`],
        affectedRepositories: [repoName],
      },
    } as never);

    const { artifactWriteCallCount, manifestWriteCallCount } = await captureArtifactWrites(() =>
      command.run([], {
        ticketKey: 'PLAN-1',
        action: 'fix',
        repos: [repoName],
      })
    );

    const [, planOptions] = generatePlan.calls[0] ?? [];
    if (
      planOptions?.affectedRepositories?.length === 1 &&
      planOptions.affectedRepositories[0] === repoName &&
      artifactWriteCallCount === 1 &&
      manifestWriteCallCount === 1
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
      plan: {
        action: 'fix',
        summary: 'Invalid plan',
        estimatedComplexity: 'low',
        steps: ['Update one file'],
        affectedFiles: ['repo-name/src/example.ts'],
        affectedRepositories: ['repo-name'],
      },
    } as never);

    const { output, exitCodes } = await captureCommandOutput(async () => {
      const { artifactWriteCallCount, manifestWriteCallCount } = await captureArtifactWrites(() =>
        command.run([], {
          ticketKey: 'PLAN-2',
          action: 'fix',
          repos: [repoName],
        })
      );

      if (artifactWriteCallCount !== 0 || manifestWriteCallCount !== 0) {
        throw new Error(
          `Unexpected artifact writes for placeholder metadata: artifact=${artifactWriteCallCount} manifest=${manifestWriteCallCount}`
        );
      }
    });

    if (exitCodes.includes(1) && output.includes('placeholder repository metadata')) {
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
      plan: {
        action: 'fix',
        summary: 'Invalid verification plan',
        estimatedComplexity: 'low',
        steps: ['Update one file'],
        affectedFiles: [`${repoName}/src/example.ts`],
        affectedRepositories: [repoName],
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
      },
    } as never);

    const { output, exitCodes } = await captureCommandOutput(async () => {
      const { artifactWriteCallCount, manifestWriteCallCount } = await captureArtifactWrites(() =>
        command.run([], {
          ticketKey: 'PLAN-3',
          action: 'fix',
          repos: [repoName],
        })
      );

      if (artifactWriteCallCount !== 0 || manifestWriteCallCount !== 0) {
        throw new Error(
          `Unexpected artifact writes for invalid verification: artifact=${artifactWriteCallCount} manifest=${manifestWriteCallCount}`
        );
      }
    });

    if (exitCodes.includes(1) && output.includes('must assert expected failure inside the command')) {
      pass('Expected-failure verification commands must be wrapped');
    } else {
      fail('Invalid verification command was not rejected as expected', output);
    }
  }

  console.log('\n🧪 Test 4: retry feedback markers are present in prompt-building paths\n');
  {
    const aiServiceSource = fs.readFileSync(path.join(process.cwd(), 'src/integrations/ai/ai.service.ts'), 'utf-8');
    const stageAgentServiceSource = fs.readFileSync(
      path.join(process.cwd(), 'src/integrations/ai/stage-agent.service.ts'),
      'utf-8'
    );
    const planStageServiceSource = fs.readFileSync(
      path.join(process.cwd(), 'src/workflows/stages/plan-stage.service.ts'),
      'utf-8'
    );

    if (
      aiServiceSource.includes('Previous plan attempt was rejected for these exact reasons:') &&
      stageAgentServiceSource.includes('Previous plan attempt was rejected for these exact reasons:') &&
      planStageServiceSource.includes('planQualityFeedback') &&
      planStageServiceSource.includes('const retryAttempt = await generatePlanAttempt(firstAttemptViolations);')
    ) {
      pass('Retry feedback markers are wired into both prompt builders and the plan stage retry path');
    } else {
      fail('Retry feedback markers are missing from the prompt or retry wiring');
    }
  }

  console.log('\n🧪 Test 5: semantic plan quality gates control artifact writes\n');
  {
    const { command, fetchArtifact, generatePlan } = await buildCommand();

    fetchArtifact.mockResolvedValue({
      ticketKey: 'PLAN-5',
      content: '# PLAN-5: Accept only semantically valid plans\n',
      path: `/tmp/.wf/${repoName}/jira/PLAN-5.md`,
    });

    let validWritePayload = '';
    const originalWriteFile = fs.promises.writeFile;
    const originalWritePlanArtifactManifest = mutablePlanArtifactUtils.writePlanArtifactManifest;
    let validManifestWriteCallCount = 0;
    fs.promises.writeFile = (async (_filePath: fs.PathLike, data: string | NodeJS.ArrayBufferView) => {
      validWritePayload = typeof data === 'string' ? data : String(data);
      return undefined;
    }) as typeof fs.promises.writeFile;
    mutablePlanArtifactUtils.writePlanArtifactManifest = ((..._args: unknown[]) => {
      validManifestWriteCallCount += 1;
      return '/tmp/mock-plan-manifest.json';
    }) as typeof planArtifactUtils.writePlanArtifactManifest;

    generatePlan.mockResolvedValueOnce({
      plan: {
        action: 'fix',
        summary: 'Corrected draft',
        estimatedComplexity: 'low',
        steps: [
          'Rename AuthService to AuthSessionService in wf/src/auth.ts.',
          'Add wf/src/auth.spec.ts with afterEach(() => jest.restoreAllMocks()) and createMockAuthRepository().',
        ],
        affectedFiles: [],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'manual-plan-validation',
              run: 'yarn test:manual -- test-issue-plan-validation',
              policy: 'enforced',
            },
          ],
        },
      },
    } as never);

    try {
      await command.run([], {
        ticketKey: 'PLAN-5',
        action: 'fix',
        repos: [repoName],
      });
    } finally {
      fs.promises.writeFile = originalWriteFile;
      mutablePlanArtifactUtils.writePlanArtifactManifest = originalWritePlanArtifactManifest;
    }

    const validPlanSaved =
      validManifestWriteCallCount === 1 &&
      validWritePayload.includes('Rename AuthService to AuthSessionService') &&
      validWritePayload.includes('jest.restoreAllMocks()') &&
      validWritePayload.includes('yarn test:manual -- test-issue-plan-validation');

    generatePlan.mockResolvedValueOnce({
      plan: {
        action: 'fix',
        summary: 'Still invalid',
        estimatedComplexity: 'low',
        steps: ['Rename AuthService in wf/src/auth.ts.'],
        affectedFiles: [],
        affectedRepositories: [repoName],
      },
    } as never);

    let invalidArtifactWriteCallCount = -1;
    let invalidManifestWriteCallCount = -1;
    const { output, exitCodes } = await captureCommandOutput(async () => {
      const writes = await captureArtifactWrites(() =>
        command.run([], {
          ticketKey: 'PLAN-5',
          action: 'fix',
          repos: [repoName],
        })
      );
      invalidArtifactWriteCallCount = writes.artifactWriteCallCount;
      invalidManifestWriteCallCount = writes.manifestWriteCallCount;
    });

    if (
      validPlanSaved &&
      invalidArtifactWriteCallCount === 0 &&
      invalidManifestWriteCallCount === 0 &&
      exitCodes.includes(1) &&
      output.includes('Generated plan failed quality checks') &&
      output.includes('rename-target-required')
    ) {
      pass('Only semantically valid plans are persisted; invalid plans are rejected before artifact write');
    } else {
      fail(
        'Semantic plan quality gates did not control artifact writes as expected',
        JSON.stringify({
          validPlanSaved,
          output,
          exitCodes,
          invalidArtifactWriteCallCount,
          invalidManifestWriteCallCount,
        })
      );
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
