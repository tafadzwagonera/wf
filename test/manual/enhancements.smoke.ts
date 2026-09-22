// test/manual/test-enhancements.ts
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean) => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

function getSuccessResult(output: string): { output: string; exitCode: number } {
  return { output, exitCode: 0 };
}

function getErrorResult(err: unknown): { output: string; exitCode: number } {
  const spawnErr = err as { stdout?: string; stderr?: string; status?: number };
  return {
    output: (spawnErr.stdout ?? '') + (spawnErr.stderr ?? ''),
    exitCode: spawnErr.status ?? 1,
  };
}

function executeCommand(cmd: string): { output: string; exitCode: number } {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    return getSuccessResult(output);
  } catch (err: unknown) {
    return getErrorResult(err);
  }
}

const run = (cmd: string): { output: string; exitCode: number } => executeCommand(cmd);

const CLI = 'npx ts-node -r tsconfig-paths/register src/main.ts';

function testE2ArtifactPath(): void {
  console.log(chalk.bold.cyan('\n🧪 E2: Artifact Path (.wf/)'));
  console.log(chalk.gray('─'.repeat(60)));
  const { output: planDryRun } = run(`${CLI} issue:plan WBP-0001 --action feature --repos test-repo --dry-run`);
  assert('issue:plan dry-run output mentions .wf/ path', planDryRun.includes('.wf/'));
}

function testE4HappyPath(): void {
  const { output: promptOut, exitCode: promptCode } = run(
    `${CLI} issue:plan --action feature --custom README.md --repos test-repo --dry-run`
  );
  assert('--custom dry-run exits 0', promptCode === 0);
  assert(
    '--custom dry-run output contains mnemonic-feature.json pattern',
    /[a-z]+-[a-z]+-[a-z]+-feature\.json/.test(promptOut)
  );
}

function testE4MutualExclusion(): void {
  const { exitCode: mutualCode, output: mutualOut } = run(
    `${CLI} issue:plan WBP-0001 --action feature --custom README.md --repos test-repo --dry-run`
  );
  assert('ticket-key + --custom exits non-zero', mutualCode !== 0);
  assert('mutual-exclusion error message mentions --custom', mutualOut.includes('--custom'));
}

function testE4MissingAction(): void {
  const { exitCode: noActionCode } = run(`${CLI} issue:plan --custom README.md --repos test-repo --dry-run`);
  assert('--custom without --action exits non-zero', noActionCode !== 0);
}

function testE4CustomForIssuePlan(): void {
  console.log(chalk.bold.cyan('\n🧪 E4: issue:plan --custom'));
  console.log(chalk.gray('─'.repeat(60)));
  testE4HappyPath();
  testE4MutualExclusion();
  testE4MissingAction();
}

function buildPlanJson(): object {
  return {
    action: 'feature',
    summary: 'Test plan',
    estimatedComplexity: 'low',
    steps: ['Step one', 'Step two'],
    affectedFiles: ['src/foo.ts'],
    affectedRepositories: ['test-repo'],
  };
}

function createTestPlanFile(): string {
  const tmpPlan = path.join(process.cwd(), '.wf', 'jira', 'test-plan-feature.json');
  fs.mkdirSync(path.dirname(tmpPlan), { recursive: true });
  fs.writeFileSync(tmpPlan, JSON.stringify(buildPlanJson()));
  return tmpPlan;
}

function testE5ValidationErrors(): void {
  const { exitCode: missingPlanCode, output: missingPlanOut } = run(
    `${CLI} issue:implement merry-tinkering-pine-feature`
  );
  assert('custom artifact without extension exits non-zero', missingPlanCode !== 0);
  assert('error mentions extension requirement', missingPlanOut.includes('extension'));
  const { exitCode: noArgsCode } = run(`${CLI} issue:implement --dry-run`);
  assert('no args exits non-zero', noArgsCode !== 0);
}

function testE5DryRun(tmpPlan: string): void {
  const { exitCode: planKeylessCode, output: planKeylessOut } = run(`${CLI} issue:implement ${tmpPlan} --dry-run`);
  assert('custom artifact dry-run exits 0', planKeylessCode === 0);
  assert('custom artifact output does NOT contain "git checkout -b"', !planKeylessOut.includes('git checkout -b'));
}

function testE5CustomArtifactExecution(): void {
  console.log(chalk.bold.cyan('\n🧪 E5: issue:implement custom artifact'));
  console.log(chalk.gray('─'.repeat(60)));
  testE5ValidationErrors();
  const tmpPlan = createTestPlanFile();
  testE5DryRun(tmpPlan);
  try {
    fs.unlinkSync(tmpPlan);
  } catch {
    /* ignore */
  }
}

function testE6Case1(): void {
  const { output: e6Out, exitCode: e6Code } = run(
    `${CLI} issue WBP-0001 --from plan --action investigate --repos test-repo --dry-run`
  );
  assert('E6-1: exit 0', e6Code === 0);
  assert('E6-1: dry-run mentions findings artifact', e6Out.includes('findings-and-recommendations'));
  assert('E6-1: dry-run does not mention branch checkout', !e6Out.includes('git checkout -b'));
}

function buildInvestigatePlanJson(): object {
  return {
    action: 'investigate',
    summary: 'Test investigation',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [],
    affectedRepositories: [],
    risks: [],
  };
}

function testE6Case2(): void {
  const investigatePlan = path.join(require('os').tmpdir(), 'test-investigate-plan.json');
  fs.writeFileSync(investigatePlan, JSON.stringify(buildInvestigatePlanJson()));
  const { output: e6PlanOut, exitCode: e6PlanCode } = run(
    `${CLI} issue:implement ${investigatePlan} --dry-run`
  );
  assert('E6-2: exit 0', e6PlanCode === 0);
  assert('E6-2: no branch checkout for investigate plan', !e6PlanOut.includes('git checkout -b'));
  try {
    fs.unlinkSync(investigatePlan);
  } catch {
    /* ignore */
  }
}

function testE6InvestigationFindings(): void {
  console.log(chalk.bold.cyan('\n§ E6 — Investigation findings flow\n'));
  testE6Case1();
  testE6Case2();
}

function printSummary(): void {
  console.log(chalk.gray('\n' + '─'.repeat(60)));
  if (failed === 0) {
    console.log(chalk.bold.green(`\n✓ All ${passed} tests passed\n`));
  } else {
    console.log(chalk.bold.red(`\n✗ ${failed} of ${passed + failed} tests failed\n`));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  testE2ArtifactPath();
  testE4CustomForIssuePlan();
  testE5CustomArtifactExecution();
  testE6InvestigationFindings();
  printSummary();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
