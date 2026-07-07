/**
 * Manual smoke test: Skill tool_use logging in CLI adapter
 *
 * Run: nr test:manual -- test-cli-skill-tool-logging
 *
 * Verifies:
 *   1. Skill tool_use with a valid skill name emits a gray diagnostic log line.
 *   2. Skill tool_use with missing skill name emits nothing.
 *   3. Skill tool_use with empty-string skill name emits nothing.
 *   4. task_progress with last_tool_name === 'Skill' and non-empty summary logs a Skill line.
 *   5. task_progress with empty summary/description does NOT log a Skill line.
 *   6. task_progress with non-Skill last_tool_name is suppressed entirely.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ClaudeCliAdapter } from '../../src/integrations/ai/adapters/claude-cli.adapter';
import type { ClaudeCliMessage } from '../../src/integrations/ai/adapters/claude-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const createMockConfigService = () =>
  ({
    get: (_key: string, fallback?: unknown) => fallback,
  }) as any;

const captureConsoleLog = (fn: () => void): string[] => {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Skill tool_use logging in CLI adapter smoke test\n'));

  const adapter = new ClaudeCliAdapter(createMockConfigService());
  const activityState = {};

  // Test 1: Skill with valid skill name
  console.log(chalk.bold('Test 1: Skill tool_use with valid skill name logs diagnostic line'));
  {
    const message: ClaudeCliMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'plan-quality' } }],
      },
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliAssistantMessage(message, '/repo', activityState);
    });

    const skillLine = logs.find(l => /Skill:.*plan-quality/.test(l));
    assert('emits a line containing "Skill: plan-quality"', !!skillLine, `captured: ${JSON.stringify(logs)}`);
  }

  // Test 2: Skill with missing skill name
  console.log(chalk.bold('\nTest 2: Skill tool_use with missing skill name emits nothing'));
  {
    const message: ClaudeCliMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: {} }],
      },
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliAssistantMessage(message, '/repo', activityState);
    });

    const skillLine = logs.find(l => /Skill:/.test(l));
    assert('no Skill line emitted when skill name is missing', !skillLine, `captured: ${JSON.stringify(logs)}`);
  }

  // Test 3: Skill with empty-string skill name
  console.log(chalk.bold('\nTest 3: Skill tool_use with empty-string skill name emits nothing'));
  {
    const message: ClaudeCliMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: '' } }],
      },
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliAssistantMessage(message, '/repo', activityState);
    });

    const skillLine = logs.find(l => /Skill:/.test(l));
    assert('no Skill line emitted when skill name is empty string', !skillLine, `captured: ${JSON.stringify(logs)}`);
  }

  // Test 4: task_progress with last_tool_name === 'Skill' and non-empty summary
  console.log(chalk.bold('\nTest 4: task_progress with Skill last_tool_name logs Skill line'));
  {
    const message: ClaudeCliMessage = {
      type: 'system',
      subtype: 'task_progress',
      last_tool_name: 'Skill',
      summary: 'executing plan-quality skill',
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliMessage(message, '/repo', activityState);
    });

    const skillLine = logs.find(l => /Skill:.*executing plan-quality skill/.test(l));
    assert(
      'emits a line containing "Skill: executing plan-quality skill"',
      !!skillLine,
      `captured: ${JSON.stringify(logs)}`
    );
  }

  // Test 5: task_progress with empty summary/description does NOT log a Skill line
  console.log(chalk.bold('\nTest 5: task_progress with empty summary/description emits nothing'));
  {
    const message: ClaudeCliMessage = {
      type: 'system',
      subtype: 'task_progress',
      last_tool_name: 'Skill',
      summary: '',
      description: '',
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliMessage(message, '/repo', activityState);
    });

    const skillLine = logs.find(l => /Skill:/.test(l));
    assert(
      'no Skill line emitted when summary and description are empty',
      !skillLine,
      `captured: ${JSON.stringify(logs)}`
    );
  }

  // Test 6: task_progress with non-Skill last_tool_name is suppressed
  console.log(chalk.bold('\nTest 6: task_progress with non-Skill tool emits nothing'));
  {
    const message: ClaudeCliMessage = {
      type: 'system',
      subtype: 'task_progress',
      last_tool_name: 'Read',
      summary: 'Reading src/commands/issue-plan.command.ts',
      description: 'Reading src/commands/issue-plan.command.ts',
    };

    const logs = captureConsoleLog(() => {
      (adapter as any).logCliMessage(message, '/repo', activityState);
    });

    assert('no output emitted for non-Skill task_progress', logs.length === 0, `captured: ${JSON.stringify(logs)}`);
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
