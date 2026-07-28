/**
 * Manual smoke test: buildSkillPromptFragment warns and skips missing SKILL.md
 *
 * Run: nr test:manual -- test-skill-prompt-fragment-graceful-skip
 *
 * Verifies:
 *   1. A missing skill ID does NOT throw — returns ''.
 *   2. A chalk.yellow warning line is emitted containing the skill ID.
 *   3. When mixing a real skill (if installed) with a missing one, only the
 *      real skill's content is included and the missing one is skipped.
 *   4. Calling with only missing skills returns ''.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { buildSkillPromptFragment, readSkillContent } from '../../src/skills/skill-content';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

const captureConsoleLogs = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return captured;
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  buildSkillPromptFragment graceful skip smoke test\n'));

  const MISSING_SKILL = 'zz-nonexistent-skill-' + Date.now();

  // Test 1: Missing skill does not throw — returns ''
  console.log(chalk.bold('Test 1: Missing skill returns empty string without throwing'));
  {
    let result: string | undefined;
    let threw = false;
    const logs = await captureConsoleLogs(async () => {
      try {
        result = await buildSkillPromptFragment([MISSING_SKILL]);
      } catch {
        threw = true;
      }
    });

    assert('does not throw', !threw);
    assert('returns empty string', result === '');

    // Test 2: Warning line emitted
    console.log(chalk.bold('\nTest 2: Warning line emitted for missing skill'));
    const warningLine = logs.find(l => l.includes(MISSING_SKILL));
    assert('warning contains the missing skill ID', !!warningLine, `captured: ${JSON.stringify(logs)}`);
    assert('warning contains "skipping disk content injection"',
      !!warningLine && warningLine.includes('skipping disk content injection'),
      `got: ${warningLine}`
    );
  }

  // Test 3: Probe for a real installed skill to test the mixed path
  console.log(chalk.bold('\nTest 3: Mixed real + missing skill (conditional on disk state)'));
  {
    const candidates = ['test-driven-development', 'receiving-code-review', 'writing-plans', 'frontend-design'];
    let realSkillId: string | null = null;

    for (const id of candidates) {
      const content = await readSkillContent(id);
      if (content !== null) {
        realSkillId = id;
        break;
      }
    }

    if (realSkillId) {
      const foundId = realSkillId;
      const logs = await captureConsoleLogs(async () => {
        const result = await buildSkillPromptFragment([foundId, MISSING_SKILL]);
        assert(`result contains "## Skill: ${foundId}"`, result.includes(`## Skill: ${foundId}`));
        assert('result does NOT contain the missing skill ID', !result.includes(MISSING_SKILL));
      });
      const warningLine = logs.find(l => l.includes(MISSING_SKILL));
      assert('warning emitted for missing skill in mixed list', !!warningLine);
    } else {
      console.log(chalk.gray('    (no installed skill found on disk — skipping mixed-input test)'));
    }
  }

  // Test 4: Multiple missing skills all skipped — returns ''
  console.log(chalk.bold('\nTest 4: Multiple missing skills all skipped'));
  {
    const result = await buildSkillPromptFragment([MISSING_SKILL, MISSING_SKILL + '-2']);
    assert('returns empty string for all-missing input', result === '');
  }

  // Test 5: Empty input returns ''
  console.log(chalk.bold('\nTest 5: Empty input returns empty string'));
  {
    const result = await buildSkillPromptFragment([]);
    assert('returns empty string for empty array', result === '');
  }

  // Summary
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main();
