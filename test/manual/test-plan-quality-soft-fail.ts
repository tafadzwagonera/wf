/**
 * Manual Test: plan quality soft-fail on second pass
 *
 * Run: nr test:manual -- test-plan-quality-soft-fail
 *
 * Verifies:
 *   1. Second-pass validation failure logs a warning instead of throwing
 *   2. Violations are surfaced in the plan's risks array with [plan-quality] prefix
 *   3. Existing risks are preserved when violations are appended
 *   4. First-pass success returns without risks injection
 */

import { Test } from '@nestjs/testing';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';

type AsyncMock<TArgs extends unknown[], TResult> = ((...args: TArgs) => Promise<TResult>) & {
  calls: TArgs[];
  mockResolvedValueOnce: (value: TResult) => void;
};

const createAsyncMock = <TArgs extends unknown[], TResult>(): AsyncMock<TArgs, TResult> => {
  const queuedResults: TResult[] = [];
  const mock = (async (...args: TArgs): Promise<TResult> => {
    mock.calls.push(args);
    const queuedResult = queuedResults.shift();
    if (queuedResult !== undefined) {
      return queuedResult;
    }
    return undefined as TResult;
  }) as AsyncMock<TArgs, TResult>;

  mock.calls = [];
  mock.mockResolvedValueOnce = (value: TResult): void => {
    queuedResults.push(value);
  };

  return mock;
};

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  ✓ ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed += 1;
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
};

const buildService = async (): Promise<{
  service: PlanStageService;
  generatePlanMock: AsyncMock<unknown[], unknown>;
}> => {
  const generatePlanMock = createAsyncMock<unknown[], unknown>();

  const module = await Test.createTestingModule({
    providers: [
      PlanStageService,
      {
        provide: AiService,
        useValue: { generatePlan: generatePlanMock },
      },
      {
        provide: StageAgentService,
        useValue: { isEnabledForStage: () => false },
      },
    ],
  }).compile();

  return {
    service: module.get(PlanStageService),
    generatePlanMock,
  };
};

const captureConsoleLogs = (): { logs: string[]; restore: () => void } => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(' '));
  };
  return { logs, restore: () => (console.log = originalLog) };
};

const main = async (): Promise<void> => {
  console.log('\n🧪 Test 1: second-pass failure logs warning and returns plan with risks\n');
  {
    const { service, generatePlanMock } = await buildService();
    const violatingPlan = {
      ...basePlan,
      steps: ['Rename AuthService in repo-a/src/auth.ts.'],
      affectedRepositories: ['repo-a'],
    };
    generatePlanMock.mockResolvedValueOnce(violatingPlan);
    generatePlanMock.mockResolvedValueOnce(violatingPlan);

    const { logs, restore } = captureConsoleLogs();

    try {
      const result = await service.generatePlan('Ticket body', {
        action: 'fix',
        ticketKey: 'WBP-SF-1',
        affectedRepositories: ['repo-a'],
      });

      restore();

      const hasWarningLog = logs.some(l => l.includes('Plan quality violations persisted after retry'));
      const hasRisks = Array.isArray(result.plan.risks) && result.plan.risks.length > 0;
      const allPrefixed = result.plan.risks?.every((r: string) => r.startsWith('[plan-quality]')) ?? false;

      if (hasWarningLog && hasRisks && allPrefixed) {
        pass('Second-pass failure logged warning, returned plan with [plan-quality] risks');
      } else {
        fail('Expected warning log and risks injection', JSON.stringify({ hasWarningLog, hasRisks, allPrefixed }));
      }
    } catch (error) {
      restore();
      fail('Service threw instead of soft-failing', String(error));
    }
  }

  console.log('\n🧪 Test 2: existing risks are preserved when violations are appended\n');
  {
    const { service, generatePlanMock } = await buildService();
    const violatingPlanWithRisks = {
      ...basePlan,
      steps: ['Rename AuthService in repo-a/src/auth.ts.'],
      affectedRepositories: ['repo-a'],
      risks: ['Pre-existing risk from AI'],
    };
    generatePlanMock.mockResolvedValueOnce(violatingPlanWithRisks);
    generatePlanMock.mockResolvedValueOnce(violatingPlanWithRisks);

    const { restore } = captureConsoleLogs();

    try {
      const result = await service.generatePlan('Ticket body', {
        action: 'fix',
        ticketKey: 'WBP-SF-2',
        affectedRepositories: ['repo-a'],
      });

      restore();

      const hasPreExisting = result.plan.risks?.includes('Pre-existing risk from AI') ?? false;
      const hasQualityRisk = result.plan.risks?.some((r: string) => r.startsWith('[plan-quality]')) ?? false;

      if (hasPreExisting && hasQualityRisk) {
        pass('Pre-existing risks preserved alongside injected quality violations');
      } else {
        fail('Risk merging failed', JSON.stringify(result.plan.risks));
      }
    } catch (error) {
      restore();
      fail('Service threw instead of soft-failing', String(error));
    }
  }

  console.log('\n🧪 Test 3: first-pass success returns plan without risks injection\n');
  {
    const { service, generatePlanMock } = await buildService();
    generatePlanMock.mockResolvedValueOnce({
      ...basePlan,
      steps: ['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.'],
      affectedRepositories: ['repo-a'],
    });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-SF-3',
      affectedRepositories: ['repo-a'],
    });

    const noQualityRisks = !(result.plan.risks ?? []).some((r: string) => r.startsWith('[plan-quality]'));

    if (noQualityRisks) {
      pass('First-pass success returns plan without [plan-quality] risks');
    } else {
      fail('Unexpected [plan-quality] risks on valid plan', JSON.stringify(result.plan.risks));
    }
  }

  console.log('\n🧪 Test 4: second-pass success after first-pass failure returns clean plan\n');
  {
    const { service, generatePlanMock } = await buildService();
    generatePlanMock.mockResolvedValueOnce({
      ...basePlan,
      steps: ['Rename AuthService in repo-a/src/auth.ts.'],
      affectedRepositories: ['repo-a'],
    });
    generatePlanMock.mockResolvedValueOnce({
      ...basePlan,
      steps: ['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.'],
      affectedRepositories: ['repo-a'],
    });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-SF-4',
      affectedRepositories: ['repo-a'],
    });

    const noQualityRisks = !(result.plan.risks ?? []).some((r: string) => r.startsWith('[plan-quality]'));
    const retried = generatePlanMock.calls.length === 2;

    if (noQualityRisks && retried) {
      pass('Retried plan that passes has no [plan-quality] risks');
    } else {
      fail('Second-pass success should not inject risks', JSON.stringify({ risks: result.plan.risks, retried }));
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
