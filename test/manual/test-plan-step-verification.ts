import chalk from 'chalk';
import {
  buildStepAssessorPrompt,
  buildPlanStepVerificationPrompt,
  validateStepAssessments,
} from '../../src/agents/plan-step-verification.service';
import { stepAssessmentResponseSchema } from '../../src/shared/schemas/step-verification.schema';
import { implementerOptionsSchema } from '../../src/shared/schemas/agent.schema';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function main(): void {
  console.log(chalk.bold('\nPlan step verification smoke test\n'));

  // 1. buildStepAssessorPrompt numbers steps from 0
  const prompt1 = buildStepAssessorPrompt(['Step A', 'Step B'], 'diff text', [], false);
  assert(
    'buildStepAssessorPrompt numbers steps from 0',
    prompt1.includes('Step 0') && prompt1.includes('Step 1'),
    `prompt excerpt: ${prompt1.slice(0, 200)}`,
  );

  // 2. buildStepAssessorPrompt includes not-applicable in status rules
  const prompt2 = buildStepAssessorPrompt(['Step A'], 'diff', [], false);
  assert(
    'buildStepAssessorPrompt includes not-applicable rule',
    prompt2.includes('not-applicable'),
    `prompt excerpt: ${prompt2.slice(0, 200)}`,
  );

  // 3. buildStepAssessorPrompt includes truncation note when truncated=true
  const prompt3 = buildStepAssessorPrompt(['Step A'], 'diff', [], true);
  assert(
    'buildStepAssessorPrompt includes truncation note when truncated=true',
    prompt3.includes('truncated'),
    `prompt excerpt: ${prompt3.slice(0, 200)}`,
  );

  // 4. buildStepAssessorPrompt omits truncation note when truncated=false
  const prompt4 = buildStepAssessorPrompt(['Step A'], 'diff', [], false);
  assert(
    'buildStepAssessorPrompt omits truncation note when truncated=false',
    !prompt4.includes('truncated'),
    `prompt excerpt: ${prompt4.slice(0, 200)}`,
  );

  // 5. stepAssessmentResponseSchema accepts valid all-done response
  let schema5Pass = false;
  try {
    const result = stepAssessmentResponseSchema.parse({
      statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'not-applicable' }],
    });
    schema5Pass = result.statuses.length === 2;
  } catch { schema5Pass = false; }
  assert('stepAssessmentResponseSchema accepts valid all-done response', schema5Pass);

  // 6. stepAssessmentResponseSchema rejects missing statuses array
  let schema6Pass = false;
  try {
    stepAssessmentResponseSchema.parse({});
    schema6Pass = false;
  } catch { schema6Pass = true; }
  assert('stepAssessmentResponseSchema rejects missing statuses array', schema6Pass);

  // 7. validateStepAssessments rejects duplicate index
  const val7 = validateStepAssessments(
    [{ index: 0, status: 'done' }, { index: 0, status: 'not-done', missing: 'x' }],
    2,
  );
  assert(
    'validateStepAssessments rejects duplicate index',
    typeof val7 === 'string',
    `got: ${JSON.stringify(val7)}`,
  );

  // 8. validateStepAssessments rejects out-of-range index
  const val8 = validateStepAssessments([{ index: 5, status: 'done' }], 2);
  assert(
    'validateStepAssessments rejects out-of-range index',
    typeof val8 === 'string',
    `got: ${JSON.stringify(val8)}`,
  );

  // 9. validateStepAssessments rejects incomplete coverage
  const val9 = validateStepAssessments([{ index: 0, status: 'done' }], 2);
  assert(
    'validateStepAssessments rejects incomplete coverage',
    typeof val9 === 'string',
    `got: ${JSON.stringify(val9)}`,
  );

  // 10. buildPlanStepVerificationPrompt includes Verification round N of M header
  const verPrompt10 = buildPlanStepVerificationPrompt(
    [{ index: 0, status: 'not-done', missing: 'implementation' }],
    1, 3,
  );
  assert(
    'buildPlanStepVerificationPrompt includes Verification round N of M header',
    verPrompt10.includes('Verification round 1 of 3'),
    `prompt excerpt: ${verPrompt10.slice(0, 200)}`,
  );

  // 11. buildPlanStepVerificationPrompt includes only pending steps (not done ones)
  const verPrompt11 = buildPlanStepVerificationPrompt(
    [{ index: 1, status: 'partially-done', missing: 'edge case' }],
    2, 3,
  );
  assert(
    'buildPlanStepVerificationPrompt includes only pending steps',
    verPrompt11.includes('Step 1') && verPrompt11.includes('edge case'),
    `prompt excerpt: ${verPrompt11.slice(0, 200)}`,
  );

  // 12. buildPlanStepVerificationPrompt includes Missing: note for partially-done
  const verPrompt12 = buildPlanStepVerificationPrompt(
    [{ index: 0, status: 'partially-done', missing: 'missing feature X' }],
    1, 3,
  );
  assert(
    'buildPlanStepVerificationPrompt includes Missing: note for partially-done',
    verPrompt12.includes('missing feature X'),
    `prompt excerpt: ${verPrompt12.slice(0, 200)}`,
  );

  // 13. buildPlanStepVerificationPrompt ends with the no-preamble instruction
  const verPrompt13 = buildPlanStepVerificationPrompt(
    [{ index: 0, status: 'not-done', missing: 'x' }],
    1, 3,
  );
  assert(
    'buildPlanStepVerificationPrompt ends with no-preamble instruction',
    verPrompt13.includes('Do not output any text or plan before making your first tool call'),
    `prompt excerpt: ${verPrompt13.slice(-200)}`,
  );

  // 14. implementerOptionsSchema.parse accepts initialPromptOverride
  let schema14Pass = false;
  try {
    const result = implementerOptionsSchema.parse({
      trackerName: 'jira',
      initialPromptOverride: 'test override prompt',
    });
    schema14Pass = result.initialPromptOverride === 'test override prompt';
  } catch { schema14Pass = false; }
  assert('implementerOptionsSchema.parse accepts initialPromptOverride', schema14Pass);

  console.log('');
  if (failed > 0) {
    console.log(chalk.red(`${failed} assertion(s) failed, ${passed} passed`));
    process.exit(1);
  } else {
    console.log(chalk.green(`All ${passed} assertions passed`));
  }
}

main();
