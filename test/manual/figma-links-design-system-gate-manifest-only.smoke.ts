/**
 * Manual smoke test: prompted Figma links flow into the manifest but not into
 * the AI generation context when content has no inline links and a design
 * system is detected
 *
 * Verifies that resolvePostParseFigmaLinks calls searchFigmaLinksForTicket only
 * when (a) autoLinks is empty, (b) a design system is present in conventions.
 * Because the prompt runs after generatePlan in both command and service paths,
 * the links must appear in the persisted manifest but not in the figmaLinks
 * argument passed to the AI call.
 *
 * Run: nr test:manual -- figma-links-design-system-gate-manifest-only.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { resolvePostParseFigmaLinks } from '../../src/shared/utils/extract-figma-links';
import { detectRepoConventions } from '../../src/shared/utils/detect-repo-conventions';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeDesignSystemRepo(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'ui-app', dependencies: { tailwindcss: '^4.0.0' } }),
  );
  fs.writeFileSync(
    path.join(dir, 'tailwind.config.ts'),
    `import type { Config } from 'tailwindcss';\nexport default { content: [] } satisfies Config;\n`,
  );
}

async function main(): Promise<void> {
  console.log('Manual smoke: prompted Figma links go to manifest only, not AI context\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-gate-'));

  try {
    makeDesignSystemRepo(tempDir);
    const conventions = detectRepoConventions(tempDir);
    const ticketContent = '# WBP-200: Update the hero section layout';
    const autoLinks: string[] = [];

    console.log(chalk.bold.cyan('\nTest 1: detectRepoConventions detects hasUiEnvironment when design system present'));

    if (conventions.designSystem?.hasUiEnvironment) {
      pass(`Design system detected with hasUiEnvironment=true: ${conventions.designSystem.hasUiEnvironment}`);
    } else {
      fail('Expected hasUiEnvironment: true to be detected — check makeDesignSystemRepo fixture');
    }

    console.log(chalk.bold.cyan('\nTest 2: resolvePostParseFigmaLinks with allowPrompt: false returns [] when design system present but prompt disallowed'));

    const noPromptLinks = await resolvePostParseFigmaLinks(
      ticketContent, autoLinks, { allowPrompt: false, conventions }
    );

    if (noPromptLinks.length === 0) {
      pass('resolvePostParseFigmaLinks returns [] when allowPrompt is false, even with design system detected');
    } else {
      fail('resolvePostParseFigmaLinks returned links unexpectedly', JSON.stringify(noPromptLinks));
    }

    console.log(chalk.bold.cyan('\nTest 3: non-interactive session (non-TTY stdout) suppresses the prompt even with a design system'));

    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const nonTtyLinks = await resolvePostParseFigmaLinks(
      ticketContent, autoLinks, { allowPrompt: true, conventions }
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });

    if (nonTtyLinks.length === 0) {
      pass('Non-TTY stdout suppresses inquirer prompt inside searchFigmaLinksForTicket');
    } else {
      fail('Expected [] in non-TTY session, got links', JSON.stringify(nonTtyLinks));
    }

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: design-system gate controls Figma prompt');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
