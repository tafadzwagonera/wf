/**
 * Manual smoke test: extractFigmaLinks preserves ?node-id= query strings end-to-end
 *
 * Verifies that the FIGMA_LINK_PATTERN change preserves query strings (including
 * multi-param query strings) and that trailing prose punctuation is still excluded.
 * Also confirms that resolvePostParseFigmaLinks passes query-bearing links through
 * unchanged on the early-return path.
 *
 * Run: nr test:manual -- figma-link-query-string-preservation.smoke
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
  console.log('Manual smoke: extractFigmaLinks preserves ?node-id= query strings end-to-end\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-qs-'));

  try {
    console.log(chalk.bold.cyan('\nTest 1: single link with ?node-id= preserved'));
    {
      const links = extractFigmaLinks('See https://figma.com/design/abc/Page?node-id=17-4 here');
      if (links.length === 1 && links[0] === 'https://figma.com/design/abc/Page?node-id=17-4') {
        pass('query string ?node-id=17-4 preserved');
      } else {
        fail('query string stripped or link missing', JSON.stringify(links));
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: two links sharing a file key but differing by ?node-id= are returned as distinct entries'));
    {
      const urlA = 'https://figma.com/design/abc123/Page?node-id=17-4';
      const urlB = 'https://figma.com/design/abc123/Page?node-id=30-10616';
      const links = extractFigmaLinks(`Desktop: ${urlA} Mobile: ${urlB}`);
      if (links.length === 2 && links[0] === urlA && links[1] === urlB) {
        pass('two distinct node-id links preserved as separate entries');
      } else {
        fail('links collapsed or order wrong', JSON.stringify(links));
      }
    }

    console.log(chalk.bold.cyan('\nTest 3: multi-param query string preserved in full'));
    {
      const links = extractFigmaLinks('See https://figma.com/design/abc/Page?node-id=1-2&t=abc123 here');
      if (links.length === 1 && links[0] === 'https://figma.com/design/abc/Page?node-id=1-2&t=abc123') {
        pass('multi-param query string ?node-id=1-2&t=abc123 preserved');
      } else {
        fail('multi-param query string stripped or wrong', JSON.stringify(links));
      }
    }

    console.log(chalk.bold.cyan('\nTest 4: trailing comma excluded, query string kept'));
    {
      const links = extractFigmaLinks('See https://figma.com/design/abc/Page?node-id=1-2, done.');
      if (links.length === 1 && links[0] === 'https://figma.com/design/abc/Page?node-id=1-2') {
        pass('trailing comma excluded, query string intact');
      } else {
        fail('trailing comma not excluded or query string stripped', JSON.stringify(links));
      }
    }

    console.log(chalk.bold.cyan('\nTest 5: trailing period excluded, query string kept'));
    {
      const links = extractFigmaLinks('End. https://figma.com/design/abc/Page?node-id=1-2. See above.');
      if (links.length === 1 && links[0] === 'https://figma.com/design/abc/Page?node-id=1-2') {
        pass('trailing period excluded, query string intact');
      } else {
        fail('trailing period not excluded or query string stripped', JSON.stringify(links));
      }
    }

    console.log(chalk.bold.cyan('\nTest 6: resolvePostParseFigmaLinks passes query-bearing links through unchanged'));
    {
      const autoLinks = ['https://figma.com/design/abc/Page?node-id=17-4'];
      const resolved = await resolvePostParseFigmaLinks('some content', autoLinks, {
        allowPrompt: false,
        repoDir: tempDir,
      });
      if (resolved.length === 1 && resolved[0] === autoLinks[0]) {
        pass('resolvePostParseFigmaLinks early-return preserves query string');
      } else {
        fail('query string not preserved through resolvePostParseFigmaLinks', JSON.stringify(resolved));
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: Figma query strings preserved end-to-end');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
