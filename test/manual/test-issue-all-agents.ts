// test/manual/test-issue-all-agents.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AgentOrchestrator } from '../../src/agents/agent-orchestrator.service';
import { FetcherAgent } from '../../src/agents/fetcher.agent';
import { PlannerAgent } from '../../src/agents/planner.agent';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { CommitterAgent } from '../../src/agents/committer.agent';
import chalk from 'chalk';
import { execSync } from 'child_process';

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

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    // ── Test 1: DI resolution ──────────────────────────────────────────────
    console.log(chalk.bold.cyan('\n🧪 Part 1: DI Resolution'));
    console.log(chalk.gray('─'.repeat(60)));

    const orchestrator = app.get(AgentOrchestrator);
    assert('AgentOrchestrator resolves', !!orchestrator);
    assert(
      'orchestrator.fetcher is FetcherAgent',
      orchestrator.fetcher instanceof FetcherAgent,
    );
    assert(
      'orchestrator.planner is PlannerAgent',
      orchestrator.planner instanceof PlannerAgent,
    );
    assert(
      'orchestrator.implementer is ImplementerAgent',
      orchestrator.implementer instanceof ImplementerAgent,
    );
    assert(
      'orchestrator.reviewer is ReviewerAgent',
      orchestrator.reviewer instanceof ReviewerAgent,
    );
    assert(
      'orchestrator.committer is CommitterAgent',
      orchestrator.committer instanceof CommitterAgent,
    );

    // ── Test 2: Agent method contracts ────────────────────────────────────
    console.log(chalk.bold.cyan('\n🧪 Part 2: Agent Method Contracts'));
    console.log(chalk.gray('─'.repeat(60)));

    assert(
      'FetcherAgent.execute is function',
      typeof orchestrator.fetcher.execute === 'function',
    );
    assert(
      'FetcherAgent.loadFromDisk is function',
      typeof orchestrator.fetcher.loadFromDisk === 'function',
    );
    assert(
      'PlannerAgent.execute is function',
      typeof orchestrator.planner.execute === 'function',
    );
    assert(
      'PlannerAgent.loadFromDisk is function',
      typeof orchestrator.planner.loadFromDisk === 'function',
    );
    assert(
      'ImplementerAgent.execute is function',
      typeof orchestrator.implementer.execute === 'function',
    );
    assert(
      'ReviewerAgent.execute is function',
      typeof orchestrator.reviewer.execute === 'function',
    );
    assert(
      'CommitterAgent.execute is function',
      typeof orchestrator.committer.execute === 'function',
    );

    // ── Test 3: FetcherAgent error on missing ticket ──────────────────────
    console.log(
      chalk.bold.cyan('\n🧪 Part 3: FetcherAgent error on missing ticket'),
    );
    console.log(chalk.gray('─'.repeat(60)));
    try {
      orchestrator.fetcher.loadFromDisk('FAKE-9999', 'jira');
      assert('throws for missing ticket', false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      assert(
        'throws descriptive error for missing ticket',
        msg.includes('Ticket file not found'),
      );
    }

    // ── Test 4: PlannerAgent error on missing plan ────────────────────────
    console.log(
      chalk.bold.cyan('\n🧪 Part 4: PlannerAgent error on missing plan'),
    );
    console.log(chalk.gray('─'.repeat(60)));
    try {
      orchestrator.planner.loadFromDisk(
        '/nonexistent/FAKE-9999.md',
        'implement',
      );
      assert('throws for missing plan', false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      assert(
        'throws descriptive error for missing plan',
        msg.includes('Plan file not found') ||
          msg.includes('No plan file found'),
      );
    }

    // ── Test 5: Dry-run end-to-end (exercises the full orchestration) ─────
    console.log(chalk.bold.cyan('\n🧪 Part 5: Dry-run end-to-end via CLI'));
    console.log(chalk.gray('─'.repeat(60)));

    const ticketKey = process.env.WF_TEST_TICKET || 'WBP-0001';
    let dryRunOutput = '';
    let dryRunExitCode = 0;

    try {
      dryRunOutput = execSync(
        `npx ts-node -r tsconfig-paths/register src/main.ts issue:all ${ticketKey} --from fetch --to commit --action implement --repos test-repo --dry-run`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
      );
    } catch (err: unknown) {
      const spawnErr = err as {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      dryRunOutput = (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '');
      dryRunExitCode = spawnErr.status ?? 1;
    }

    assert('dry-run exits 0', dryRunExitCode === 0);
    assert(
      'dry-run output contains FETCH stage',
      dryRunOutput.includes('fetch') || dryRunOutput.includes('FETCH'),
    );
    assert(
      'dry-run output contains PLAN stage',
      dryRunOutput.includes('plan') || dryRunOutput.includes('PLAN'),
    );
    assert(
      'dry-run output contains REVIEW stage',
      dryRunOutput.includes('review') || dryRunOutput.includes('REVIEW'),
    );
    assert(
      'dry-run output contains COMMIT stage',
      dryRunOutput.includes('commit') || dryRunOutput.includes('COMMIT'),
    );

    // ── Test 6: --action guard (plan stage without action = error) ────────
    console.log(chalk.bold.cyan('\n🧪 Part 6: --action guard'));
    console.log(chalk.gray('─'.repeat(60)));

    let guardOutput = '';
    let guardExitCode = 0;
    try {
      // --dry-run ensures the guard fires before any filesystem lookup,
      // so the test is reliable regardless of whether the ticket file exists.
      guardOutput = execSync(
        `npx ts-node -r tsconfig-paths/register src/main.ts issue:all ${ticketKey} --from plan --to plan --repos test-repo --dry-run`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
      );
    } catch (err: unknown) {
      const spawnErr = err as {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      guardOutput = (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '');
      guardExitCode = spawnErr.status ?? 1;
    }

    assert(
      'exits non-zero when --action missing for plan stage',
      guardExitCode !== 0,
    );
    assert(
      'error mentions --action',
      guardOutput.includes('--action') || guardOutput.includes('action'),
    );
  } finally {
    await app.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
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
