/**
 * Manual Test: disk-loaded plan quality violations are downgraded to risks
 *
 * Run: yarn test:manual -- test-disk-loaded-plan-quality-tolerance
 *
 * Verifies:
 *   1. loadPlanArtifact resolves when disk plan has rename step missing a target
 *   2. Returned plan.risks[] contains [plan-quality] entry for rename-target-required
 *   3. Console output contains chalk.yellow warning with violation details
 *   4. createPlanArtifact (skipExisting) resolves when cached plan has disallowed verification command
 *   5. Returned plan.risks[] contains [plan-quality] entry for verification-allowlist
 *   6. Console output contains verification-allowlist in the warning
 *   7. A clean plan returns with no extra risks appended (no false-positive injection)
 *
 * Coverage gap: test/manual/test-issue-plan-validation.ts Test 5 covers the
 * generation-path tolerance in IssuePlanCommand. This test covers the disk-load
 * path in PlanStageService.validateLoadedPlan(), which bypasses the command
 * layer entirely (exercised by `wf issue --to implement`).
 */

import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import * as detectTestInfraModule from '../../src/shared/utils/detect-test-infra';
import type { TestInfraContext } from '../../src/shared/types/detection.types';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  \u2713 ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`);
  failed += 1;
};

const basePlan = {
  action: 'fix' as const,
  summary: 'Fix auth redirect',
  estimatedComplexity: 'low' as const,
  steps: ['Inspect redirect logic', 'Adjust callback handling'],
  affectedFiles: ['src/auth/callback.ts'],
  affectedRepositories: ['repo-a'],
  verification: {
    targeted: [
      {
        id: 'auth-smoke',
        run: 'yarn test -- --testPathPatterns=src/auth',
        policy: 'enforced' as const,
      },
    ],
  },
};

const stubTestInfra: TestInfraContext = {
  ecosystems: [
    {
      ecosystem: 'node' as const,
      nodeVersionMajor: 22,
      hasNodeTest: true,
      frameworks: ['jest' as const],
      scripts: { test: 'jest', build: 'nest build' },
      allScriptNames: ['test', 'build'],
      testPatterns: {
        fileSuffix: '.spec' as const,
        mockPrefix: 'mock',
        mockFactoryPrefix: 'createMock',
        describeStyle: 'flat' as const,
        helperPaths: [],
        mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' as const },
        diSetupPattern: 'testing-module' as const,
        errorHandlerExits: true,
      },
    },
  ],
  primary: 'node' as const,
};

const buildService = async (): Promise<PlanStageService> => {
  const module = await Test.createTestingModule({
    providers: [
      PlanStageService,
      {
        provide: AiService,
        useValue: { generatePlan: () => Promise.reject(new Error('generatePlan must not be called in disk-load tests')) },
      },
      {
        provide: StageAgentService,
        useValue: {
          isEnabledForStage: () => false,
          generatePlan: () => Promise.reject(new Error('agent generatePlan must not be called in disk-load tests')),
        },
      },
    ],
  }).compile();

  return module.get(PlanStageService);
};

const createTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-disk-quality-'));

const writePlanToDisk = (
  tempDir: string,
  ticketKey: string,
  plan: Record<string, unknown>,
): { ticketPath: string; planPath: string } => {
  const ticketPath = path.join(tempDir, `${ticketKey}.md`);
  fs.writeFileSync(ticketPath, `# ${ticketKey}: Test`);

  const hash = hashPlanArtifactSources([ticketKey]);
  const createdAt = new Date('2026-07-25T00:00:00.000Z');
  const planFilename = buildPlanArtifactFilename({
    createdAt,
    hash,
    action: 'fix',
    format: 'json',
  });
  const planPath = path.join(tempDir, planFilename);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  writePlanArtifactManifest(
    buildPlanArtifactManifest(planPath, 'fix', 'json', hash, ticketKey, 'ticket', createdAt),
  );

  return { ticketPath, planPath };
};

interface CapturedOutput {
  chunks: string[];
}

const captureConsoleLog = (): CapturedOutput & { restore: () => void } => {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    chunks.push(args.map(String).join(' '));
    originalLog.apply(console, args);
  };
  return {
    chunks,
    restore: () => {
      console.log = originalLog;
    },
  };
};

const stubDetectTestInfra = (): (() => void) => {
  const original = detectTestInfraModule.detectTestInfra;
  (detectTestInfraModule as { detectTestInfra: typeof detectTestInfraModule.detectTestInfra }).detectTestInfra
    = (() => stubTestInfra) as typeof detectTestInfraModule.detectTestInfra;
  return () => {
    (detectTestInfraModule as { detectTestInfra: typeof detectTestInfraModule.detectTestInfra }).detectTestInfra
      = original;
  };
};

const run = async (): Promise<void> => {
  const service = await buildService();
  const tempDirs: string[] = [];

  const cleanup = (): void => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const restoreDetectTestInfra = stubDetectTestInfra();

  try {
    // Test 1-3: loadPlanArtifact with rename step missing target
    console.log('\n\ud83e\uddea Test 1-3: loadPlanArtifact downgrades rename-target-required violations\n');
    {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      const planWithBadRename = {
        ...basePlan,
        steps: ['Rename AuthService in src/auth.ts'],
      };
      const { ticketPath } = writePlanToDisk(tempDir, 'WBP-DISK-1', planWithBadRename);

      const captured = captureConsoleLog();
      try {
        const result = await service.loadPlanArtifact(ticketPath);

        const hasRiskEntry = (result.plan.risks ?? []).some(
          (r: string) => /\[plan-quality\].*rename-target-required/.test(r),
        );

        if (hasRiskEntry) {
          pass('plan.risks contains [plan-quality]..rename-target-required entry');
        } else {
          fail('plan.risks missing rename-target-required entry', JSON.stringify(result.plan.risks));
        }

        const warningLogged = captured.chunks.some(
          chunk => chunk.includes('Plan quality violations (loaded plan)') && chunk.includes('rename-target-required'),
        );

        if (warningLogged) {
          pass('Console warning contains rename-target-required violation');
        } else {
          fail('Console warning missing expected violation text', captured.chunks.join('\n'));
        }

        pass('loadPlanArtifact resolved without throwing');
      } catch (error) {
        fail('loadPlanArtifact threw instead of downgrading violations', String(error));
      } finally {
        captured.restore();
      }
    }

    // Test 4-6: createPlanArtifact (skipExisting) with disallowed verification command
    console.log('\n\ud83e\uddea Test 4-6: createPlanArtifact downgrades verification-allowlist violations\n');
    {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      const planWithBadVerification = {
        ...basePlan,
        verification: {
          targeted: [
            {
              id: 'disallowed-cmd',
              run: 'curl http://localhost:3000',
              policy: 'enforced' as const,
            },
          ],
        },
      };
      const { ticketPath } = writePlanToDisk(tempDir, 'WBP-DISK-2', planWithBadVerification);

      const captured = captureConsoleLog();
      try {
        const result = await service.createPlanArtifact(
          { ticketKey: 'WBP-DISK-2', content: '# WBP-DISK-2: Test', path: ticketPath },
          { action: 'fix', skipExisting: true },
        );

        const hasRiskEntry = (result.plan.risks ?? []).some(
          (r: string) => /\[plan-quality\].*verification-allowlist/.test(r),
        );

        if (hasRiskEntry) {
          pass('plan.risks contains [plan-quality]..verification-allowlist entry');
        } else {
          fail('plan.risks missing verification-allowlist entry', JSON.stringify(result.plan.risks));
        }

        const warningLogged = captured.chunks.some(
          chunk => chunk.includes('verification-allowlist'),
        );

        if (warningLogged) {
          pass('Console warning contains verification-allowlist violation');
        } else {
          fail('Console warning missing expected violation text', captured.chunks.join('\n'));
        }

        pass('createPlanArtifact resolved without throwing');
      } catch (error) {
        fail('createPlanArtifact threw instead of downgrading violations', String(error));
      } finally {
        captured.restore();
      }
    }

    // Test 7: clean plan has no extra risks appended
    console.log('\n\ud83e\uddea Test 7: clean plan returns with no false-positive risk injection\n');
    {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      const cleanPlan = {
        ...basePlan,
        steps: ['Rename AuthService to AuthSessionService in src/auth.ts.'],
        risks: ['Regression in login flow'],
      };
      const { ticketPath } = writePlanToDisk(tempDir, 'WBP-DISK-3', cleanPlan);

      try {
        const result = await service.loadPlanArtifact(ticketPath);
        const risks = result.plan.risks ?? [];
        const hasPlanQualityRisk = risks.some((r: string) => r.includes('[plan-quality]'));

        if (!hasPlanQualityRisk && risks.length === 1 && risks[0] === 'Regression in login flow') {
          pass('Clean plan returned with original risks only — no false-positive injection');
        } else {
          fail('Clean plan had unexpected risks', JSON.stringify(risks));
        }
      } catch (error) {
        fail('loadPlanArtifact threw on a clean plan', String(error));
      }
    }
  } finally {
    restoreDetectTestInfra();
    cleanup();
  }

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${passed} passed   \u274c ${failed} failed`);
  if (failed === 0) {
    console.log('\u2705 All tests passed!');
  }
  console.log('\u2501'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
