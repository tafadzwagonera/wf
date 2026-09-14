/**
 * Manual smoke test: resolvePostParseFigmaLinks filters malformed autoLinks and
 * falls through to design-system detection when all provided links are invalid.
 *
 * Run: nr test:manual -- figma-autolinks-malformed-filter.smoke
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

async function main(): Promise<void> {
  console.log('Manual smoke: resolvePostParseFigmaLinks malformed-autoLinks filter\n');

  const designSystemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-ds-'));
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-plain-'));

  try {
    makeDesignSystemRepo(designSystemDir);

    // Case 1: partial-malformed — valid subset returned, no design-system check triggered.
    // We pass conventions with hasUiEnvironment:true so that if detectRepoConventions were
    // incorrectly called via fallthrough, searchFigmaLinksForTicket would find no links in
    // the content and return [] — proving a wrong result. The expected return is the valid
    // link only.
    const case1 = await resolvePostParseFigmaLinks(
      'no figma links here',
      ["https://figma.com/design/X/Y'", 'https://figma.com/design/A/B'],
      { allowPrompt: false, conventions: { designSystem: { hasUiEnvironment: true } } },
    );

    if (case1.length === 1 && case1[0] === 'https://figma.com/design/A/B') {
      pass('partial-malformed: returns valid subset, malformed link excluded');
    } else {
      fail('partial-malformed: unexpected result', JSON.stringify(case1));
    }

    // Case 2: all-malformed — falls through to design-system detection. The temp dir has
    // tailwind so detectRepoConventions returns hasUiEnvironment:true. Content contains a
    // clean figma URL; searchFigmaLinksForTicket(content, false) returns it. If the filter
    // failed to fall through, valid.length would be 1 (malformed kept), returning early with
    // the malformed URL — not matching the expected result.
    const contentWithLink = 'See https://figma.com/design/abc/Screen for reference.';
    const case2 = await resolvePostParseFigmaLinks(
      contentWithLink,
      ["https://figma.com/design/X/Y'"],
      { allowPrompt: false, repoDir: designSystemDir },
    );

    if (case2.length === 1 && case2[0] === 'https://figma.com/design/abc/Screen') {
      pass('all-malformed: falls through to design-system detection, returns link from content');
    } else {
      fail('all-malformed: unexpected result', JSON.stringify(case2));
    }

    // Case 3: empty autoLinks — unchanged prior behaviour, falls through to design-system
    // detection. Plain dir has no design system so returns [].
    const case3 = await resolvePostParseFigmaLinks(
      'no figma links here',
      [],
      { allowPrompt: false, repoDir: plainDir },
    );

    if (case3.length === 0) {
      pass('empty autoLinks: returns [] when no design system present');
    } else {
      fail('empty autoLinks: unexpected result', JSON.stringify(case3));
    }

    // Case 4: all-valid — fast path, returned unchanged.
    const case4 = await resolvePostParseFigmaLinks(
      'no figma links here',
      ['https://figma.com/design/A/B'],
      { allowPrompt: false, repoDir: plainDir },
    );

    if (case4.length === 1 && case4[0] === 'https://figma.com/design/A/B') {
      pass('all-valid: returns links unchanged via fast path');
    } else {
      fail('all-valid: unexpected result', JSON.stringify(case4));
    }
  } finally {
    fs.rmSync(designSystemDir, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: malformed-autoLinks filter and fallthrough behave correctly');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
