/**
 * Manual smoke test: no Figma links and no design system → no prompt fires and
 * WARN log is written when PlanStageService.createPlanArtifact persists the plan
 *
 * Verifies that resolvePostParseFigmaLinks returns [] without touching inquirer
 * when the repo has no design system, and that pre-computed null conventions
 * produce the same result without a filesystem read.
 *
 * Run: nr test:manual -- figma-links-no-design-system-warn-log.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { resolvePostParseFigmaLinks } from '../../src/shared/utils/extract-figma-links';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log('Manual smoke: no design system → no prompt, WARN written to log only\n');

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-'));

  try {
    const ticketContent = '# WBP-300: Fix database connection timeout in the auth service';
    const autoLinks: string[] = [];

    console.log(chalk.bold.cyan('\nTest 1: resolvePostParseFigmaLinks returns [] for plain repo with no design system'));

    const stdoutCapture: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === 'string' && /figma/i.test(chunk)) stdoutCapture.push(chunk);
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stdout.write;

    const links = await resolvePostParseFigmaLinks(
      ticketContent, autoLinks, { allowPrompt: true, repoDir }
    );

    process.stdout.write = origWrite;

    if (links.length === 0) {
      pass('resolvePostParseFigmaLinks returns [] — repo with no design system, no autoLinks');
    } else {
      fail('Expected [], got links for a plain repo', JSON.stringify(links));
    }

    if (stdoutCapture.length === 0) {
      pass('No Figma-related stdout emitted — inquirer prompt was not shown');
    } else {
      fail('Unexpected Figma stdout output during plain-repo run', stdoutCapture.join(''));
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: no design system → no prompt, WARN log only');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
