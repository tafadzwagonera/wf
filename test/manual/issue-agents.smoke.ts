// test/manual/test-issue-agents.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AgentOrchestrator } from '../../src/agents/agent-orchestrator.service';
import { FetcherAgent } from '../../src/agents/fetcher.agent';
import { PlannerAgent } from '../../src/agents/planner.agent';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { CommitterAgent } from '../../src/agents/committer.agent';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

function checkDiResolution(orchestrator: AgentOrchestrator): void {
  assert('AgentOrchestrator resolves', !!orchestrator);
  assert('orchestrator.fetcher is FetcherAgent', orchestrator.fetcher instanceof FetcherAgent);
  assert('orchestrator.planner is PlannerAgent', orchestrator.planner instanceof PlannerAgent);
  assert('orchestrator.implementer is ImplementerAgent', orchestrator.implementer instanceof ImplementerAgent);
  assert('orchestrator.reviewer is ReviewerAgent', orchestrator.reviewer instanceof ReviewerAgent);
  assert('orchestrator.committer is CommitterAgent', orchestrator.committer instanceof CommitterAgent);
}

function checkAgentMethodContracts(orchestrator: AgentOrchestrator): void {
  assert('FetcherAgent.execute is function', typeof orchestrator.fetcher.execute === 'function');
  assert('FetcherAgent.loadFromDisk is function', typeof orchestrator.fetcher.loadFromDisk === 'function');
  assert('PlannerAgent.execute is function', typeof orchestrator.planner.execute === 'function');
  assert('PlannerAgent.loadFromDisk is function', typeof orchestrator.planner.loadFromDisk === 'function');
  assert('ImplementerAgent.execute is function', typeof orchestrator.implementer.execute === 'function');
  assert('ReviewerAgent.execute is function', typeof orchestrator.reviewer.execute === 'function');
  assert('CommitterAgent.execute is function', typeof orchestrator.committer.execute === 'function');
}

function checkFetcherError(orchestrator: AgentOrchestrator): void {
  try {
    orchestrator.fetcher.loadFromDisk('FAKE-9999', 'jira');
    assert('throws for missing ticket', false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    assert('throws descriptive error for missing ticket', msg.includes('Ticket file not found'));
  }
}

async function checkPlannerError(orchestrator: AgentOrchestrator): Promise<void> {
  try {
    await orchestrator.planner.loadFromDisk('/nonexistent/FAKE-9999.md', 'feature');
    assert('throws for missing plan', false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    assert(
      'throws descriptive error for missing plan',
      msg.includes('Plan file not found') || msg.includes('No plan file found')
    );
  }
}

function runDryRunCli(ticketKey: string, extraArgs: string): { output: string; exitCode: number } {
  let dryRunOutput = '';
  let dryRunExitCode = 0;
  try {
    dryRunOutput = execSync(
      `npx ts-node -r tsconfig-paths/register src/main.ts issue ${ticketKey} ${extraArgs}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 }
    );
  } catch (err: unknown) {
    const spawnErr = err as { stdout?: string; stderr?: string; status?: number };
    dryRunOutput = (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '');
    dryRunExitCode = spawnErr.status ?? 1;
  }
  return { output: dryRunOutput, exitCode: dryRunExitCode };
}

function checkDryRunEndToEnd(ticketKey: string): void {
  const { output, exitCode } = runDryRunCli(ticketKey, '--from fetch --to commit --action feature --repos test-repo --dry-run');
  assert('dry-run exits 0', exitCode === 0);
  assert('dry-run output contains FETCH stage', output.includes('fetch') || output.includes('FETCH'));
  assert('dry-run output contains PLAN stage', output.includes('plan') || output.includes('PLAN'));
  assert('dry-run output contains REVIEW stage', output.includes('review') || output.includes('REVIEW'));
  assert('dry-run output contains COMMIT stage', output.includes('commit') || output.includes('COMMIT'));
}

function checkActionGuard(ticketKey: string): void {
  const { output, exitCode } = runDryRunCli(ticketKey, '--from plan --to plan --repos test-repo --dry-run');
  assert('exits non-zero when --action missing for plan stage', exitCode !== 0);
  assert('error mentions --action', output.includes('--action') || output.includes('action'));
}

async function runParts1to4(orchestrator: AgentOrchestrator): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Part 1: DI Resolution'));
  console.log(chalk.gray('─'.repeat(60)));
  checkDiResolution(orchestrator);
  console.log(chalk.bold.cyan('\n🧪 Part 2: Agent Method Contracts'));
  console.log(chalk.gray('─'.repeat(60)));
  checkAgentMethodContracts(orchestrator);
  console.log(chalk.bold.cyan('\n🧪 Part 3: FetcherAgent error on missing ticket'));
  console.log(chalk.gray('─'.repeat(60)));
  checkFetcherError(orchestrator);
  console.log(chalk.bold.cyan('\n🧪 Part 4: PlannerAgent error on missing plan'));
  console.log(chalk.gray('─'.repeat(60)));
  await checkPlannerError(orchestrator);
}

function runParts5and6(ticketKey: string): void {
  console.log(chalk.bold.cyan('\n🧪 Part 5: Dry-run end-to-end via CLI'));
  console.log(chalk.gray('─'.repeat(60)));
  checkDryRunEndToEnd(ticketKey);
  console.log(chalk.bold.cyan('\n🧪 Part 6: --action guard'));
  console.log(chalk.gray('─'.repeat(60)));
  checkActionGuard(ticketKey);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ticketKey = process.env.WF_TEST_TICKET || 'WBP-0001';
  try {
    const orchestrator = app.get(AgentOrchestrator);
    await runParts1to4(orchestrator);
    runParts5and6(ticketKey);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
