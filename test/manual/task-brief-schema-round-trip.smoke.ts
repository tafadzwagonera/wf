/**
 * Manual smoke test: BuildTaskBriefParams Zod schema round-trip with buildTaskBrief
 *
 * Run: nr test:manual task-brief-schema-round-trip.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

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

function checkFullParams() {
  const fullParsed = buildTaskBriefParamsSchema.parse(FULL_PARAMS);
  assert('full params parsed successfully', fullParsed.ticketKey === 'SCHEMA-1');
  assert('parsed planAction is feature', fullParsed.planAction === 'feature');
  assert('parsed phases has one entry', fullParsed.phases?.length === 1);
  return fullParsed;
}

function checkMinimalParams(): void {
  const minimalParsed = buildTaskBriefParamsSchema.parse(MINIMAL_PARAMS);
  assert('minimal params parsed successfully (optionals omitted)', minimalParsed.ticketKey === 'SCHEMA-2');
  assert('minimal params has undefined planSummary', minimalParsed.planSummary === undefined);
  assert('minimal params has undefined planRisks', minimalParsed.planRisks === undefined);
}

function parseThrowsZodError(parse: () => void): boolean {
  try {
    parse();
    return false;
  } catch (e) {
    return e instanceof ZodError;
  }
}

function checkSchemaRejections(): void {
  assert(
    'rejects when ticketKey is missing',
    parseThrowsZodError(() => buildTaskBriefParamsSchema.parse({ ...MINIMAL_PARAMS, ticketKey: undefined })),
  );
  assert(
    'rejects when verificationScripts contains invalid entries',
    parseThrowsZodError(() =>
      buildTaskBriefParamsSchema.parse({ ...MINIMAL_PARAMS, verificationScripts: [{ bad: true }] })),
  );
  assert(
    'rejects when repoDir is missing',
    parseThrowsZodError(() => buildPlanContextParamsSchema.parse(FULL_PARAMS)),
  );
}

function parsePlanContext(fullParsed: ReturnType<typeof buildTaskBriefParamsSchema.parse>) {
  const planCtxParsed = buildPlanContextParamsSchema.parse({ ...fullParsed, repoDir: '/tmp/repo' });
  assert('plan context params parsed with repoDir', planCtxParsed.repoDir === '/tmp/repo');
  return planCtxParsed;
}

function assertBriefContent(briefOutput: string): void {
  assert('output contains Ticket key', briefOutput.includes('Ticket key: SCHEMA-1'));
  assert('output contains Plan summary', briefOutput.includes('Refactor the module'));
  assert('output contains Plan steps', briefOutput.includes('1. Step one'));
  assert('output contains Verification commands', briefOutput.includes('yarn build'));
  assert('output contains Risks and considerations', briefOutput.includes('May break downstream'));
}

function assertBriefMetadata(briefOutput: string): void {
  assert('output contains Skill-specific instructions', briefOutput.includes("Skill('tdd')"));
  assert('output contains Phase checkpoints', briefOutput.includes('Phase 1: Phase A'));
}

function checkBuildTaskBrief(fullParsed: ReturnType<typeof buildTaskBriefParamsSchema.parse>): void {
  const briefOutput = buildTaskBrief(fullParsed);
  assert('buildTaskBrief accepts schema-parsed output', typeof briefOutput === 'string');
  assertBriefContent(briefOutput);
  assertBriefMetadata(briefOutput);
}

function checkBuildPlanContext(planCtxParsed: ReturnType<typeof buildPlanContextParamsSchema.parse>): void {
  const planCtxOutput = buildPlanContext(planCtxParsed);
  assert('buildPlanContext accepts schema-parsed output', typeof planCtxOutput === 'string');
  assert('buildPlanContext starts with behavioral context', planCtxOutput.startsWith('You are an expert software engineer'));
  assert('buildPlanContext contains repository directory', planCtxOutput.includes('Repository directory: /tmp/repo'));
  assert('buildPlanContext contains task brief content', planCtxOutput.includes('Ticket key: SCHEMA-1'));
}

async function main(): Promise<void> {
  console.log(chalk.bold('\n  Scenario 1: buildTaskBriefParamsSchema parse\n'));
  const fullParsed = checkFullParams();
  checkMinimalParams();
  console.log(chalk.bold('\n  Scenario 2: buildTaskBriefParamsSchema rejection\n'));
  checkSchemaRejections();
  console.log(chalk.bold('\n  Scenario 3: buildPlanContextParamsSchema parse\n'));
  const planCtxParsed = parsePlanContext(fullParsed);
  console.log(chalk.bold('\n  Scenario 4: parsed output accepted by prompt builders\n'));
  checkBuildTaskBrief(fullParsed);
  checkBuildPlanContext(planCtxParsed);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
