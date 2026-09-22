// test/manual/chat-ui-message-budget.smoke.ts
import chalk from 'chalk';
import type { AiService } from '../../src/integrations/ai/ai.service';
import { ChatUIService } from '../../src/integrations/ai/conversation/chat-ui.service';

const service = new ChatUIService({
  getProviderShortName: () => 'AI',
} as AiService);

// Override inquirer to capture prompt messages without waiting for input
const capturedMessages: string[] = [];
(service as any).inquirer = async (config: any) => {
  capturedMessages.push(config.message);
  return { message: 'exit' };
};

interface TestCase {
  turn: number;
  maxTurns: number;
  expected: string;
}

function buildTestCases(): TestCase[] {
  return [
    { turn: 1, maxTurns: 20, expected: '19 turns left (1/20)' },
    { turn: 10, maxTurns: 20, expected: '10 turns left (10/20)' },
    { turn: 20, maxTurns: 20, expected: '0 turns left (20/20)' },
    { turn: 1, maxTurns: 5, expected: '4 turns left (1/5)' },
  ];
}

async function runSingleCase(turn: number, maxTurns: number, expected: string): Promise<boolean> {
  capturedMessages.length = 0;
  await service.promptUserInput(turn, maxTurns);
  const message = capturedMessages[0] ?? '';
  const ok = message.includes(expected);
  console.log(
    ok ? chalk.green('  PASS') : chalk.red('  FAIL'),
    `turn=${turn}, maxTurns=${maxTurns}`,
    ok ? `contains "${expected}"` : `expected "${expected}" in "${message}"`
  );
  return ok;
}

function printSummary(passed: number, total: number): void {
  console.log();
  console.log(
    passed === total
      ? chalk.green(`All ${total} cases passed.`)
      : chalk.red(`${passed}/${total} cases passed.`)
  );
  console.log(chalk.bold('\n--- End of test ---\n'));
}

async function main(): Promise<void> {
  console.log(chalk.bold('\n--- Test: message budget in conversation prompt ---\n'));
  const cases = buildTestCases();
  let passed = 0;
  for (const { turn, maxTurns, expected } of cases) {
    if (await runSingleCase(turn, maxTurns, expected)) passed += 1;
  }
  printSummary(passed, cases.length);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
