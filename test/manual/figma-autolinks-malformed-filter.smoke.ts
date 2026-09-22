/**
 * Manual smoke test: resolvePostParseFigmaLinks filters malformed autoLinks and
 * falls through to design-system detection when all provided links are invalid.
 *
 * Run: nr test:manual figma-autolinks-malformed-filter.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolvePostParseFigmaLinks } from '../../src/shared/utils/extract-figma-links';
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

function setupTempDirs(): { designSystemDir: string; plainDir: string } {
  const designSystemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-ds-'));
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-plain-'));
  makeDesignSystemRepo(designSystemDir);
  return { designSystemDir, plainDir };
}

function cleanupTempDirs(designSystemDir: string, plainDir: string): void {
  fs.rmSync(designSystemDir, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
}

function reportResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: malformed-autoLinks filter and fallthrough behave correctly');
}

async function runPartialMalformedCase(designSystemDir: string): Promise<void> {
  const result = await resolvePostParseFigmaLinks(
    'no figma links here',
    ["https://figma.com/design/X/Y'", 'https://figma.com/design/A/B'],
    { allowPrompt: false, conventions: { designSystem: { hasUiEnvironment: true } } },
  );
  if (result.length === 1 && result[0] === 'https://figma.com/design/A/B') {
    pass('partial-malformed: returns valid subset, malformed link excluded');
  } else {
    fail('partial-malformed: unexpected result', JSON.stringify(result));
  }
}

async function runAllMalformedCase(designSystemDir: string): Promise<void> {
  const contentWithLink = 'See https://figma.com/design/abc/Screen for reference.';
  const result = await resolvePostParseFigmaLinks(
    contentWithLink,
    ["https://figma.com/design/X/Y'"],
    { allowPrompt: false, repoDir: designSystemDir },
  );
  if (result.length === 1 && result[0] === 'https://figma.com/design/abc/Screen') {
    pass('all-malformed: falls through to design-system detection, returns link from content');
  } else {
    fail('all-malformed: unexpected result', JSON.stringify(result));
  }
}

async function runEmptyAutoLinksCase(plainDir: string): Promise<void> {
  const result = await resolvePostParseFigmaLinks(
    'no figma links here',
    [],
    { allowPrompt: false, repoDir: plainDir },
  );
  if (result.length === 0) {
    pass('empty autoLinks: returns [] when no design system present');
  } else {
    fail('empty autoLinks: unexpected result', JSON.stringify(result));
  }
}

async function runAllValidCase(plainDir: string): Promise<void> {
  const result = await resolvePostParseFigmaLinks(
    'no figma links here',
    ['https://figma.com/design/A/B'],
    { allowPrompt: false, repoDir: plainDir },
  );
  if (result.length === 1 && result[0] === 'https://figma.com/design/A/B') {
    pass('all-valid: returns links unchanged via fast path');
  } else {
    fail('all-valid: unexpected result', JSON.stringify(result));
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: resolvePostParseFigmaLinks malformed-autoLinks filter\n');
  const { designSystemDir, plainDir } = setupTempDirs();
  try {
    await runPartialMalformedCase(designSystemDir);
    await runAllMalformedCase(designSystemDir);
    await runEmptyAutoLinksCase(plainDir);
    await runAllValidCase(plainDir);
  } finally {
    cleanupTempDirs(designSystemDir, plainDir);
  }
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
