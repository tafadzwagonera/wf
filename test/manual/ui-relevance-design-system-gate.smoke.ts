/**
 * Manual smoke test: design-system prompt section is gated on ticket UI-relevance
 *
 * Verifies that formatRepoConventionsPromptSection omits the design-system block
 * when includeDesignSystem is false and includes it when true, and that
 * isUiRelevantTicket correctly classifies UI vs non-UI ticket text so the
 * gate computes correctly end-to-end.
 *
 * Run: nr test:manual -- ui-relevance-design-system-gate.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { isUiRelevantTicket } from '../../src/shared/utils/detect-ui-relevance';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
} from '../../src/shared/utils/detect-repo-conventions';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ui-gate-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: { tailwindcss: '^4.0.0' } }),
  );
  fs.writeFileSync(
    path.join(dir, 'tailwind.config.ts'),
    `import type { Config } from 'tailwindcss';\nexport default { darkMode: 'class', content: [] } satisfies Config;\n`,
  );
  return dir;
}

async function main(): Promise<void> {
  console.log('Manual smoke: design-system prompt section is gated on UI-relevance\n');

  const repos: string[] = [];

  try {
    const dir = makeRepo();
    repos.push(dir);
    const ctx = detectRepoConventions(dir);

    console.log(chalk.bold.cyan('\nPart 1: isUiRelevantTicket classification'));

    const backendTicket = 'Fix database connection timeout in the auth service';
    const uiTicket = 'Fix the card component layout on mobile';
    const figmaOverride = 'Fix database connection timeout in the auth service';

    if (!isUiRelevantTicket(backendTicket)) {
      pass('Backend ticket classified as non-UI');
    } else {
      fail('Backend ticket incorrectly classified as UI', backendTicket);
    }

    if (isUiRelevantTicket(uiTicket)) {
      pass('UI ticket classified as UI');
    } else {
      fail('UI ticket incorrectly classified as non-UI', uiTicket);
    }

    if (!isUiRelevantTicket('classify the error type by category')) {
      pass(String.raw`"classify" does not false-positive on \bclasses?\b`);
    } else {
      fail('"classify" incorrectly matched as UI');
    }

    console.log(chalk.bold.cyan('\nPart 2: formatRepoConventionsPromptSection includeDesignSystem gate'));

    const withDesignSystem = formatRepoConventionsPromptSection(ctx, 'test-repo', { includeDesignSystem: true });
    const withoutDesignSystem = formatRepoConventionsPromptSection(ctx, 'test-repo', { includeDesignSystem: false });
    const defaultInclude = formatRepoConventionsPromptSection(ctx, 'test-repo');

    if (withDesignSystem.includes('Design system:')) {
      pass('includeDesignSystem: true → "Design system:" present');
    } else {
      fail('includeDesignSystem: true → "Design system:" absent', withDesignSystem.slice(0, 300));
    }

    if (!withoutDesignSystem.includes('Design system:')) {
      pass('includeDesignSystem: false → "Design system:" absent');
    } else {
      fail('includeDesignSystem: false → "Design system:" still present', withoutDesignSystem.slice(0, 300));
    }

    if (withoutDesignSystem.includes('Repository conventions')) {
      pass('includeDesignSystem: false → "Repository conventions" still present');
    } else {
      fail('includeDesignSystem: false → "Repository conventions" unexpectedly absent');
    }

    if (defaultInclude.includes('Design system:')) {
      pass('omitting opts defaults to includeDesignSystem: true');
    } else {
      fail('omitting opts unexpectedly excludes "Design system:"', defaultInclude.slice(0, 300));
    }

    console.log(chalk.bold.cyan('\nPart 3: end-to-end gate composition (isUiRelevant drives includeDesignSystem)'));

    const noFigmaLinks: string[] = [];
    const isUiRelevantBackend = Boolean(noFigmaLinks.length) || isUiRelevantTicket(backendTicket);
    const promptBackend = formatRepoConventionsPromptSection(ctx, 'test-repo', { includeDesignSystem: isUiRelevantBackend });
    if (promptBackend.includes('Design system:')) {
      fail('Backend ticket → design-system section unexpectedly included');
    } else {
      pass('Backend ticket → isUiRelevant=false → design-system section omitted from prompt');
    }

    const isUiRelevantUi = Boolean(noFigmaLinks.length) || isUiRelevantTicket(uiTicket);
    const promptUi = formatRepoConventionsPromptSection(ctx, 'test-repo', { includeDesignSystem: isUiRelevantUi });
    if (promptUi.includes('Design system:')) {
      pass('UI ticket → isUiRelevant=true → design-system section included in prompt');
    } else {
      fail('UI ticket → design-system section unexpectedly omitted');
    }

    const isUiRelevantFigma = Boolean(['https://figma.com/file/abc/Frame-1'].length) || isUiRelevantTicket(figmaOverride);
    const promptFigma = formatRepoConventionsPromptSection(ctx, 'test-repo', { includeDesignSystem: isUiRelevantFigma });
    if (promptFigma.includes('Design system:')) {
      pass('Figma links present → isUiRelevant=true even for backend ticket → design-system included');
    } else {
      fail('Figma links present → design-system unexpectedly omitted');
    }
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: design-system prompt section gated on UI-relevance');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
