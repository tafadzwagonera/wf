/**
 * Manual smoke test: BuildTaskBriefParams Zod schema round-trip with buildTaskBrief
 *
 * Run: nr test:manual -- test-task-brief-schema-round-trip
 *
 * Verifies:
 *   1. buildTaskBriefParamsSchema.parse succeeds for valid input.
 *   2. buildTaskBriefParamsSchema.parse succeeds with all optional fields omitted.
 *   3. buildTaskBriefParamsSchema.parse rejects missing required fields.
 *   4. buildPlanContextParamsSchema.parse succeeds with repoDir.
 *   5. buildPlanContextParamsSchema.parse rejects when repoDir is missing.
 *   6. Parsed output is accepted by buildTaskBrief and buildPlanContext.
 *   7. Output strings contain the expected sections.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ZodError } from 'zod';
import {
  buildTaskBriefParamsSchema,
  buildPlanContextParamsSchema,
} from '../../src/shared/schemas/agent.schema';
import { buildTaskBrief, buildPlanContext } from '../../src/integrations/ai/adapters/shared-routing';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

const FULL_PARAMS = {
  ticketKey: 'SCHEMA-1',
  repoName: 'my-repo',
  repoFiles: ['my-repo/src/index.ts'],
  contextFiles: ['my-repo/README.md'],
  trackedFilePaths: ['my-repo/src/index.ts'],
  verificationScripts: [
    { id: 'build', name: 'build', command: 'yarn build', policy: 'enforced', aliases: [] },
  ],
  planSteps: ['Step one', 'Step two'],
  planSummary: 'Refactor the module',
  planRisks: ['May break downstream'],
  planAction: 'feature' as const,
  skillNames: ['tdd'],
  phases: [{ label: 'Phase A', stepIndices: [0], verifyAfter: ['yarn lint'] }],
};

const MINIMAL_PARAMS = {
  ticketKey: 'SCHEMA-2',
  repoName: 'repo',
  repoFiles: ['repo/a.ts'],
  trackedFilePaths: ['repo/a.ts'],
  verificationScripts: [
    { id: 'test', name: 'test', command: 'yarn test', policy: 'enforced', aliases: [] },
  ],
  planSteps: ['Do something'],
};

async function main(): Promise<void> {
  console.log(chalk.bold('\n  Scenario 1: buildTaskBriefParamsSchema parse\n'));

  const fullParsed = buildTaskBriefParamsSchema.parse(FULL_PARAMS);
  assert('full params parsed successfully', fullParsed.ticketKey === 'SCHEMA-1');
  assert('parsed planAction is feature', fullParsed.planAction === 'feature');
  assert('parsed phases has one entry', fullParsed.phases?.length === 1);

  const minimalParsed = buildTaskBriefParamsSchema.parse(MINIMAL_PARAMS);
  assert('minimal params parsed successfully (optionals omitted)', minimalParsed.ticketKey === 'SCHEMA-2');
  assert('minimal params has undefined planSummary', minimalParsed.planSummary === undefined);
  assert('minimal params has undefined planRisks', minimalParsed.planRisks === undefined);

  console.log(chalk.bold('\n  Scenario 2: buildTaskBriefParamsSchema rejection\n'));

  let missingTicketKey = false;
  try {
    buildTaskBriefParamsSchema.parse({ ...MINIMAL_PARAMS, ticketKey: undefined });
  } catch (e) {
    missingTicketKey = e instanceof ZodError;
  }
  assert('rejects when ticketKey is missing', missingTicketKey);

  let invalidScript = false;
  try {
    buildTaskBriefParamsSchema.parse({ ...MINIMAL_PARAMS, verificationScripts: [{ bad: true }] });
  } catch (e) {
    invalidScript = e instanceof ZodError;
  }
  assert('rejects when verificationScripts contains invalid entries', invalidScript);

  console.log(chalk.bold('\n  Scenario 3: buildPlanContextParamsSchema parse\n'));

  const planCtxParsed = buildPlanContextParamsSchema.parse({ ...FULL_PARAMS, repoDir: '/tmp/repo' });
  assert('plan context params parsed with repoDir', planCtxParsed.repoDir === '/tmp/repo');

  let missingRepoDir = false;
  try {
    buildPlanContextParamsSchema.parse(FULL_PARAMS);
  } catch (e) {
    missingRepoDir = e instanceof ZodError;
  }
  assert('rejects when repoDir is missing', missingRepoDir);

  console.log(chalk.bold('\n  Scenario 4: parsed output accepted by prompt builders\n'));

  const briefOutput = buildTaskBrief(fullParsed);
  assert('buildTaskBrief accepts schema-parsed output', typeof briefOutput === 'string');
  assert('output contains Ticket key', briefOutput.includes('Ticket key: SCHEMA-1'));
  assert('output contains Plan summary', briefOutput.includes('Refactor the module'));
  assert('output contains Plan steps', briefOutput.includes('1. Step one'));
  assert('output contains Verification commands', briefOutput.includes('yarn build'));
  assert('output contains Risks and considerations', briefOutput.includes('May break downstream'));
  assert('output contains Skill-specific instructions', briefOutput.includes("Skill('tdd')"));
  assert('output contains Phase checkpoints', briefOutput.includes('Phase 1: Phase A'));

  const planCtxOutput = buildPlanContext(planCtxParsed);
  assert('buildPlanContext accepts schema-parsed output', typeof planCtxOutput === 'string');
  assert('buildPlanContext starts with behavioral context',
    planCtxOutput.startsWith('You are an expert software engineer'));
  assert('buildPlanContext contains repository directory',
    planCtxOutput.includes('Repository directory: /tmp/repo'));
  assert('buildPlanContext contains task brief content',
    planCtxOutput.includes('Ticket key: SCHEMA-1'));

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
