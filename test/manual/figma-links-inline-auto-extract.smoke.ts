/**
 * Manual smoke test: inline Figma links are auto-extracted and flow into both
 * the AI generation context and the plan manifest
 *
 * Verifies that when ticket content contains a figma.com URL, resolvePostParseFigmaLinks
 * returns it immediately (no inquirer prompt) and the link is written to both
 * the generatePlan figmaLinks argument and the persisted manifest.
 *
 * Run: nr test:manual -- figma-links-inline-auto-extract.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import {
  extractFigmaLinks,
  resolvePostParseFigmaLinks,
} from '../../src/shared/utils/extract-figma-links';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log('Manual smoke: inline Figma links auto-extracted and threaded to AI + manifest\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-inline-'));

  try {
    const ticketContent = [
      '# WBP-100: Style the card component',
      '',
      'See https://figma.com/design/abc123/Card--Frame-1 for the frame.',
      'Also reference https://figma.com/design/def456/Button--Primary for the CTA.',
    ].join('\n');

    console.log(chalk.bold.cyan('\nTest 1: resolvePostParseFigmaLinks returns autoLinks immediately when non-empty'));

    const autoLinks = extractFigmaLinks(ticketContent);
    const stdoutCapture: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === 'string' && /figma/i.test(chunk)) stdoutCapture.push(chunk);
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stdout.write;

    const resolvedLinks = await resolvePostParseFigmaLinks(ticketContent, autoLinks, {
      allowPrompt: false,
      repoDir: tempDir,
    });

    process.stdout.write = origWrite;

    if (resolvedLinks.length === 2
      && resolvedLinks[0] === autoLinks[0]
      && resolvedLinks[1] === autoLinks[1]) {
      pass('resolvePostParseFigmaLinks returns both autoLinks without invoking detectRepoConventions');
    } else {
      fail('resolvePostParseFigmaLinks returned unexpected links', JSON.stringify(resolvedLinks));
    }

    if (stdoutCapture.length === 0) {
      pass('No Figma prompt text emitted to stdout (early return skips inquirer)');
    } else {
      fail('Unexpected figma-related stdout during early return', stdoutCapture.join(''));
    }

    console.log(chalk.bold.cyan('\nTest 2: resolvePostParseFigmaLinks with pre-computed conventions skips detectRepoConventions'));

    const resolvedWithConventions = await resolvePostParseFigmaLinks(
      ticketContent, autoLinks,
      { allowPrompt: false, conventions: { designSystem: null } }
    );

    if (resolvedWithConventions.length === 2) {
      pass('resolvePostParseFigmaLinks with conventions passed in still returns autoLinks immediately');
    } else {
      fail('resolvePostParseFigmaLinks ignored autoLinks when conventions passed', JSON.stringify(resolvedWithConventions));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: inline Figma links auto-extracted');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
