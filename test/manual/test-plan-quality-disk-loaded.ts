/**
 * Manual Test: plan quality validation on disk-loaded plans
 *
 * Run: nr test:manual -- test-plan-quality-disk-loaded
 *
 * Verifies:
 *   1. createPlanArtifact throws ValidationError on cached plan with rename violations
 *   2. loadPlanArtifact throws ValidationError on loaded plan with disallowed verification commands
 *   3. createPlanArtifact returns cached plan when quality checks pass
 *   4. loadPlanArtifact returns loaded plan when quality checks pass
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { ValidationError } from '../../src/shared/utils/errors';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { detectTestInfra } from '../../src/shared/utils/detect-test-infra';

let passed = 0;
let failed = 0;
const tempDirs: string[] = [];

const pass = (message: string): void => {
  console.log(`  \u2713 ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`);
  failed += 1;
};

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-quality-disk-'));
  tempDirs.push(dir);
  return dir;
};

const cleanup = (): void => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
};

const basePlan = {
  action: 'fix',
  summary: 'Update auth redirect handling',
  estimatedComplexity: 'medium',
  steps: ['Inspect redirect logic', 'Adjust callback handling'],
  affectedFiles: ['src/auth/callback.ts'],
  verification: {
    targeted: [
      {
        id: 'manual-auth-smoke',
        run: 'yarn test:manual -- test-auth-redirect',
        policy: 'enforced',
        reason: 'Covers redirect callback flow',
      },
    ],
  },
  risks: ['Regression in login flow'],
};

const writePlanFixture = (
  tempDir: string,
  sourceName: string,
  planOverrides: Record<string, unknown>
): { planPath: string; ticketPath: string } => {
  const ticketPath = path.join(tempDir, `${sourceName}.md`);
  fs.writeFileSync(ticketPath, `# ${sourceName}: Test`);

  const hash = hashPlanArtifactSources([sourceName]);
  const createdAt = new Date('2026-04-16T00:00:00.000Z');
  const planFilename = buildPlanArtifactFilename({
    createdAt,
    hash,
    action: 'fix',
    format: 'json',
  });
  const planPath = path.join(tempDir, planFilename);
  const plan = { ...basePlan, ...planOverrides };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const manifest = buildPlanArtifactManifest(
    planPath, 'fix', 'json', hash, sourceName, 'ticket', createdAt
  );
  writePlanArtifactManifest(manifest);

  return { planPath, ticketPath };
};

const buildService = async (): Promise<PlanStageService> => {
  const realTestInfra = detectTestInfra(process.cwd());
  const module = await Test.createTestingModule({
    providers: [
      PlanStageService,
      {
        provide: AiService,
        useValue: { generatePlan: async () => basePlan },
      },
      {
        provide: StageAgentService,
        useValue: { isEnabledForStage: () => false },
      },
    ],
  }).compile();

  return module.get(PlanStageService);
};

const main = async (): Promise<void> => {
  const service = await buildService();

  console.log('\n\uD83E\uDDEA Test 1: createPlanArtifact throws on cached plan with rename violation\n');
  {
    const tempDir = createTempDir();
    const { ticketPath } = writePlanFixture(tempDir, 'WBP-DISK-1', {
      steps: ['Rename AuthService in src/auth.ts'],
      affectedRepositories: ['repo-a'],
    });

    try {
      await service.createPlanArtifact(
        { ticketKey: 'WBP-DISK-1', content: '# WBP-DISK-1: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );
      fail('Expected ValidationError but no error was thrown');
    } catch (error) {
      if (error instanceof ValidationError && String(error.message).includes('rename-target-required')) {
        pass('createPlanArtifact threw ValidationError with rename-target-required');
      } else {
        fail('Wrong error type or message', String(error));
      }
    }
  }

  console.log('\n\uD83E\uDDEA Test 2: loadPlanArtifact throws on loaded plan with disallowed verification\n');
  {
    const tempDir = createTempDir();
    const { ticketPath } = writePlanFixture(tempDir, 'WBP-DISK-2', {
      verification: {
        targeted: [{ id: 'bad-cmd', run: 'curl http://localhost:3000', policy: 'enforced' }],
      },
      affectedRepositories: ['repo-a'],
    });

    try {
      await service.loadPlanArtifact(ticketPath);
      fail('Expected ValidationError but no error was thrown');
    } catch (error) {
      if (error instanceof ValidationError && String(error.message).includes('verification-allowlist')) {
        pass('loadPlanArtifact threw ValidationError with verification-allowlist');
      } else {
        fail('Wrong error type or message', String(error));
      }
    }
  }

  console.log('\n\uD83E\uDDEA Test 3: createPlanArtifact returns cached plan when quality checks pass\n');
  {
    const tempDir = createTempDir();
    const { ticketPath } = writePlanFixture(tempDir, 'WBP-DISK-3', {
      steps: ['Rename AuthService to AuthSessionService in src/auth.ts.'],
      verification: {
        targeted: [{ id: 'test-script', run: 'node -e "console.log(1)"', policy: 'enforced' }],
      },
      affectedRepositories: ['repo-a'],
    });

    try {
      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-DISK-3', content: '# WBP-DISK-3: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      if (artifact.fromCache === true && artifact.plan.action === 'fix') {
        pass('createPlanArtifact returned valid cached plan');
      } else {
        fail('Unexpected artifact state', JSON.stringify({ fromCache: artifact.fromCache, action: artifact.plan.action }));
      }
    } catch (error) {
      fail('Unexpected error on valid plan', String(error));
    }
  }

  console.log('\n\uD83E\uDDEA Test 4: loadPlanArtifact returns loaded plan when quality checks pass\n');
  {
    const tempDir = createTempDir();
    const { ticketPath } = writePlanFixture(tempDir, 'WBP-DISK-4', {
      steps: ['Rename AuthService to AuthSessionService in src/auth.ts.'],
      verification: {
        targeted: [{ id: 'test-script', run: 'node -e "console.log(1)"', policy: 'enforced' }],
      },
      affectedRepositories: ['repo-a'],
    });

    try {
      const artifact = await service.loadPlanArtifact(ticketPath);

      if (artifact.fromCache === true && artifact.plan.action === 'fix') {
        pass('loadPlanArtifact returned valid loaded plan');
      } else {
        fail('Unexpected artifact state', JSON.stringify({ fromCache: artifact.fromCache, action: artifact.plan.action }));
      }
    } catch (error) {
      fail('Unexpected error on valid plan', String(error));
    }
  }

  cleanup();

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${passed} passed   \u274C ${failed} failed`);
  if (failed === 0) {
    console.log('\u2705 All tests passed!');
  }
  console.log('\u2501'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
};

main();
