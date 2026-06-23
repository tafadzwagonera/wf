/**
 * Manual smoke test for tightened review criteria and second/third-order thinking.
 *
 * Verifies:
 * 1. All 11 default review guidelines are present and alphabetically ordered
 * 2. Removed criteria (Deletability, Simplicity, Proportionality, Quality, Structure) are absent
 * 3. New criteria (Contracts, Ripple effects, Documentation, Testing) are present
 * 4. Merged criteria (Necessity, Scope) replace their predecessors
 *
 * Run:
 *   yarn test:manual -- test-issue-review-tightened-criteria
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/integrations/ai/ai.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';

const EXPECTED_CRITERIA = [
  'Boundaries',
  'Clarity',
  'Contracts',
  'Conventions',
  'Documentation',
  'Failure handling',
  'Necessity',
  'Ripple effects',
  'Scope',
  'Security',
  'Testing',
];

const REMOVED_CRITERIA = ['Deletability', 'Proportionality', 'Quality', 'Simplicity', 'Structure'];

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: tightened review criteria + second/third-order thinking\n');

  let capturedGuidelines: string[] = [];

  const module = await Test.createTestingModule({
    providers: [
      ReviewStageService,
      {
        provide: ConfigService,
        useValue: {
          get: (_key: string, fallback?: unknown) => fallback,
        },
      },
      {
        provide: AiService,
        useValue: {
          reviewCode: async (_diff: string, guidelines: string[]) => {
            capturedGuidelines = guidelines;
            return {
              summary: 'Test',
              issues: [],
              suggestions: [],
              approved: true,
              traceProvenance: 'best-effort',
              callStack: [],
              stateTransition: {},
            };
          },
        },
      },
      {
        provide: StageAgentService,
        useValue: {
          isEnabledForStage: () => false,
        },
      },
    ],
  }).compile();

  const service = module.get(ReviewStageService);
  await service.reviewDiff('diff --git a/file b/file', {
    context: 'ticket TEST-100: Tightened criteria smoke',
  });

  // ── Part 1: All 11 expected criteria are present ──

  for (const criterion of EXPECTED_CRITERIA) {
    const found = capturedGuidelines.some(g => g.startsWith(`${criterion}:`));
    if (!found) {
      throw new Error(
        `Expected "${criterion}" criterion in default guidelines. Got:\n${capturedGuidelines.join('\n')}`
      );
    }
  }

  console.log('  ✅ Part 1: All 11 expected criteria are present');

  // ── Part 2: Removed criteria are absent ──

  for (const removed of REMOVED_CRITERIA) {
    const found = capturedGuidelines.some(g => g.startsWith(`${removed}:`));
    if (found) {
      throw new Error(`Removed criterion "${removed}" should not appear in default guidelines.`);
    }
  }

  console.log(
    '  ✅ Part 2: Removed criteria (Deletability, Simplicity, Proportionality, Quality, Structure) are absent'
  );

  // ── Part 3: Guidelines are alphabetically ordered ──

  const criteriaNames = capturedGuidelines
    .filter(g => g.includes(':'))
    .slice(0, 11)
    .map(g => g.split(':')[0]);

  const sorted = [...criteriaNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  const isOrdered = criteriaNames.every((name, index) => name === sorted[index]);
  if (!isOrdered) {
    throw new Error(
      `Guidelines are not alphabetically ordered.\nExpected: ${sorted.join(', ')}\nGot: ${criteriaNames.join(', ')}`
    );
  }

  console.log('  ✅ Part 3: Guidelines are alphabetically ordered');

  // ── Part 4: Second-order (Contracts) and third-order (Ripple effects) criteria have specific phrasing ──

  const contractsGuideline = capturedGuidelines.find(g => g.startsWith('Contracts:'));
  if (!contractsGuideline?.includes('function signatures')) {
    throw new Error('Contracts criterion must mention "function signatures" for second-order thinking.');
  }

  const rippleGuideline = capturedGuidelines.find(g => g.startsWith('Ripple effects:'));
  if (!rippleGuideline?.includes('downstream consumers')) {
    throw new Error('Ripple effects criterion must mention "downstream consumers" for third-order thinking.');
  }

  console.log('  ✅ Part 4: Second-order (Contracts) and third-order (Ripple effects) phrasing verified');

  // ── Part 5: replaceCriteria bypasses defaults entirely ──

  let replacedGuidelines: string[] = [];

  const replaceModule = await Test.createTestingModule({
    providers: [
      ReviewStageService,
      {
        provide: ConfigService,
        useValue: {
          get: (_key: string, fallback?: unknown) => fallback,
        },
      },
      {
        provide: AiService,
        useValue: {
          reviewCode: async (_diff: string, guidelines: string[]) => {
            replacedGuidelines = guidelines;
            return {
              summary: 'Test',
              issues: [],
              suggestions: [],
              approved: true,
              traceProvenance: 'best-effort',
              callStack: [],
              stateTransition: {},
            };
          },
        },
      },
      {
        provide: StageAgentService,
        useValue: {
          isEnabledForStage: () => false,
        },
      },
    ],
  }).compile();

  const replaceService = replaceModule.get(ReviewStageService);
  await replaceService.reviewDiff('diff --git a/file b/file', {
    context: 'ticket TEST-101: Replace criteria check',
    extraCriteria: ['Custom: my criterion'],
    replaceCriteria: true,
  });

  const hasDefault = replacedGuidelines.some(g => g.startsWith('Boundaries:'));
  if (hasDefault) {
    throw new Error('replaceCriteria=true should bypass all default guidelines.');
  }

  const hasCustom = replacedGuidelines.some(g => g.startsWith('Custom:'));
  if (!hasCustom) {
    throw new Error('replaceCriteria=true should include the custom criterion.');
  }

  console.log('  ✅ Part 5: replaceCriteria bypasses defaults entirely');

  console.log('\n✅ Manual smoke test passed: tightened review criteria + second/third-order thinking');
}

run().catch(error => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
