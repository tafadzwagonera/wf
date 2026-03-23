// test/manual/test-enhancements.ts
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

const run = (cmd: string): { output: string; exitCode: number } => {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30_000,
    });
    return { output, exitCode: 0 };
  } catch (err: unknown) {
    const spawnErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      output: (spawnErr.stdout ?? '') + (spawnErr.stderr ?? ''),
      exitCode: spawnErr.status ?? 1,
    };
  }
};

const CLI = 'npx ts-node -r tsconfig-paths/register src/main.ts';

async function main() {
  // ── E2: Artifact path ──────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E2: Artifact Path (.wf/)'));
  console.log(chalk.gray('─'.repeat(60)));

  const { output: planDryRun } = run(
    `${CLI} issue:plan WBP-0001 --action feature --repos test-repo --dry-run`,
  );
  assert(
    'issue:plan dry-run output mentions .wf/ path',
    planDryRun.includes('.wf/'),
  );

  // ── E4: --prompt for issue:plan ────────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E4: issue:plan --prompt'));
  console.log(chalk.gray('─'.repeat(60)));

  // Happy path: --prompt dry-run exits 0 and output contains a mnemonic filename
  const { output: promptOut, exitCode: promptCode } = run(
    `${CLI} issue:plan --prompt "add dark mode toggle" --action feature --repos test-repo --dry-run`,
  );
  assert('--prompt dry-run exits 0', promptCode === 0);
  assert(
    '--prompt dry-run output contains mnemonic-feature.json pattern',
    /[a-z]+-[a-z]+-[a-z]+-feature\.json/.test(promptOut),
  );

  // Mutual exclusion: ticket-key + --prompt → non-zero exit
  const { exitCode: mutualCode, output: mutualOut } = run(
    `${CLI} issue:plan WBP-0001 --prompt "foo" --action feature --repos test-repo --dry-run`,
  );
  assert('ticket-key + --prompt exits non-zero', mutualCode !== 0);
  assert(
    'mutual-exclusion error message mentions --prompt',
    mutualOut.includes('--prompt'),
  );

  // force-recreate is silently ignored with --prompt
  const { exitCode: forceCode } = run(
    `${CLI} issue:plan --prompt "add dark mode" --action feature --repos test-repo --force-recreate --dry-run`,
  );
  assert(
    '--prompt + --force-recreate exits 0 (force-recreate silently ignored)',
    forceCode === 0,
  );

  // Missing --action → non-zero
  const { exitCode: noActionCode } = run(
    `${CLI} issue:plan --prompt "add dark mode" --repos test-repo --dry-run`,
  );
  assert('--prompt without --action exits non-zero', noActionCode !== 0);

  // ── E5: --plan for issue:implement ────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E5: issue:implement --plan'));
  console.log(chalk.gray('─'.repeat(60)));

  // Non-existent plan → "Plan file not found"
  const { exitCode: missingPlanCode, output: missingPlanOut } = run(
    `${CLI} issue:implement --plan /nonexistent/path.json`,
  );
  assert('--plan /nonexistent exits non-zero', missingPlanCode !== 0);
  assert(
    'error mentions "Plan file not found"',
    missingPlanOut.includes('Plan file not found'),
  );

  // No ticketKey, no --plan → non-zero
  const { exitCode: noArgsCode } = run(`${CLI} issue:implement --dry-run`);
  assert('no args exits non-zero', noArgsCode !== 0);

  // --plan keyless dry-run: exits 0, no "git checkout -b"
  // Create a minimal valid plan JSON for the test
  const tmpPlan = path.join(
    process.cwd(),
    '.wf',
    'jira',
    'test-plan-feature.json',
  );
  fs.mkdirSync(path.dirname(tmpPlan), { recursive: true });
  fs.writeFileSync(
    tmpPlan,
    JSON.stringify({
      action: 'feature',
      summary: 'Test plan',
      estimatedComplexity: 'low',
      steps: ['Step one', 'Step two'],
      filesAffected: ['src/foo.ts'],
      repositoriesAffected: ['test-repo'],
    }),
  );

  const { exitCode: planKeylessCode, output: planKeylessOut } = run(
    `${CLI} issue:implement --plan ${tmpPlan} --dry-run`,
  );
  assert('--plan keyless dry-run exits 0', planKeylessCode === 0);
  assert(
    '--plan keyless output does NOT contain "git checkout -b"',
    !planKeylessOut.includes('git checkout -b'),
  );

  // --plan keyless without --repos exits 0 (repos is optional in keyless mode)
  const { exitCode: noReposCode } = run(
    `${CLI} issue:implement --plan ${tmpPlan} --dry-run`,
  );
  assert(
    '--plan without --repos exits 0 (repos optional in keyless mode)',
    noReposCode === 0,
  );

  // Cleanup
  try {
    fs.unlinkSync(tmpPlan);
  } catch {
    /* ignore */
  }

  // ── E6: Investigation findings flow ─────────────────────────────────────
  console.log(chalk.bold.cyan('\n§ E6 — Investigation findings flow\n'));

  // E6-1: issue:all dry-run with --action investigate shows findings preview, not branch
  {
    const { output: e6Out, exitCode: e6Code } = run(
      `${CLI} issue:all WBP-0001 --from plan --action investigate --repos test-repo --dry-run`,
    );
    assert('E6-1: exit 0', e6Code === 0);
    assert(
      'E6-1: dry-run mentions findings artifact',
      e6Out.includes('findings-and-recommendations'),
    );
    assert(
      'E6-1: dry-run does not mention branch checkout',
      !e6Out.includes('git checkout -b'),
    );
  }

  // E6-2: issue:implement --plan <investigate-plan> --dry-run exits 0 without branch
  {
    const investigatePlan = path.join(
      require('os').tmpdir(),
      'test-investigate-plan.json',
    );
    fs.writeFileSync(
      investigatePlan,
      JSON.stringify({
        action: 'investigate',
        summary: 'Test investigation',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        filesAffected: [],
        repositoriesAffected: [],
        risks: [],
      }),
    );
    const { output: e6PlanOut, exitCode: e6PlanCode } = run(
      `${CLI} issue:implement --plan ${investigatePlan} --dry-run`,
    );
    assert('E6-2: exit 0', e6PlanCode === 0);
    assert(
      'E6-2: no branch checkout for investigate plan',
      !e6PlanOut.includes('git checkout -b'),
    );
    try {
      fs.unlinkSync(investigatePlan);
    } catch {
      /* ignore */
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(chalk.gray('\n' + '─'.repeat(60)));
  if (failed === 0) {
    console.log(chalk.bold.green(`\n✅ All ${passed} tests passed\n`));
  } else {
    console.log(
      chalk.bold.red(`\n✗ ${failed} of ${passed + failed} tests failed\n`),
    );
    process.exit(1);
  }
}

void main();
