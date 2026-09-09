/**
 * Manual smoke test: buildFigmaContextSection emits indented layout tree in prompt text
 *
 * Verifies that the prompt section includes the frame header (URL, name, screenshot)
 * followed by a "Layout:" block with indented property annotations for fills, padding,
 * gap, cornerRadius, typography, and text. Multiple frames are separated by "---".
 *
 * Run: nr test:manual -- figma-layout-in-prompt.smoke
 */

import chalk from 'chalk';
import { buildFigmaContextSection } from '../../src/integrations/ai/prompt-fragments';
import { FigmaFrameContext } from '../../src/integrations/figma/figma-rest.client';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const HERO_URL = 'https://www.figma.com/design/X/File?node-id=1-1';
const MOBILE_URL = 'https://www.figma.com/design/X/File?node-id=2-2';

const heroFrame: FigmaFrameContext = {
  url: HERO_URL,
  name: 'Hero',
  width: 1440,
  height: 900,
  screenshotUrl: 'https://s3.example.com/hero.png',
  layout: {
    name: 'Hero',
    width: 1440,
    height: 900,
    layoutMode: 'HORIZONTAL',
    gap: 24,
    paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32,
    fills: [{ type: 'SOLID', hex: '#ffffff' }],
    children: [
      {
        name: 'Headline',
        type: 'TEXT',
        width: 600,
        height: 80,
        typography: { fontSize: 48, fontWeight: 700, lineHeightPx: 56 },
        text: 'Welcome to the platform',
      },
    ],
  },
};

const mobileFrame: FigmaFrameContext = {
  url: MOBILE_URL,
  name: 'Mobile',
  width: 390,
  height: 844,
  screenshotUrl: 'https://s3.example.com/mobile.png',
  layout: { name: 'Mobile', width: 390, height: 844 },
};

async function main(): Promise<void> {
  console.log('Manual smoke: buildFigmaContextSection emits indented layout tree\n');

  console.log(chalk.bold.cyan('\nTest 1: frame header fields present'));
  {
    const out = buildFigmaContextSection([heroFrame]);

    out.includes(`Frame: ${HERO_URL}`)
      ? pass('output includes Frame URL')
      : fail('Frame URL missing', out.slice(0, 200));

    out.includes('Name: Hero (1440×900px)')
      ? pass('output includes Name line with dimensions')
      : fail('Name line missing or wrong', out.slice(0, 200));

    out.includes('Screenshot: https://s3.example.com/hero.png')
      ? pass('output includes Screenshot URL')
      : fail('Screenshot line missing', out.slice(0, 200));

    out.includes('Layout:')
      ? pass('output includes "Layout:" section header')
      : fail('"Layout:" section header missing', out.slice(0, 300));
  }

  console.log(chalk.bold.cyan('\nTest 2: layout annotations — layoutMode, padding, gap, fill'));
  {
    const out = buildFigmaContextSection([heroFrame]);

    /hero.*horizontal/i.test(out)
      ? pass('layoutMode "horizontal" appears after node name')
      : fail('layoutMode "horizontal" missing', out.slice(0, 400));

    out.includes('pad:32px')
      ? pass('pad:32px emitted (all sides equal → compact form)')
      : fail('pad:32px missing', out.slice(0, 400));

    out.includes('gap:24px')
      ? pass('gap:24px present')
      : fail('gap:24px missing', out.slice(0, 400));

    out.includes('fill:#ffffff')
      ? pass('fill:#ffffff present')
      : fail('fill:#ffffff missing', out.slice(0, 400));
  }

  console.log(chalk.bold.cyan('\nTest 3: child node with typography and text annotation'));
  {
    const out = buildFigmaContextSection([heroFrame]);

    out.includes('Headline (600×80px)')
      ? pass('child node "Headline" with dimensions emitted')
      : fail('child node "Headline" missing', out.slice(0, 500));

    out.includes('[font:48px w700 lh:56px]')
      ? pass('[font:48px w700 lh:56px] present')
      : fail('[font:...] annotation missing or wrong', out.slice(0, 500));

    out.includes('[text:"Welcome to the platform"]')
      ? pass('[text:"Welcome to the platform"] present')
      : fail('[text:...] annotation missing', out.slice(0, 500));
  }

  console.log(chalk.bold.cyan('\nTest 4: multi-frame output separated by "---"'));
  {
    const out = buildFigmaContextSection([heroFrame, mobileFrame]);

    out.includes('---')
      ? pass('"---" separator present between frames')
      : fail('"---" separator missing', out.slice(0, 200));

    out.includes(`Frame: ${MOBILE_URL}`)
      ? pass('second frame URL present')
      : fail('second frame URL missing', out.slice(0, 400));

    out.includes('Name: Mobile (390×844px)')
      ? pass('second frame name and dimensions present')
      : fail('second frame name/dimensions wrong', out.slice(0, 400));
  }

  console.log(chalk.bold.cyan('\nTest 5: asymmetric padding uses full four-value form'));
  {
    const asymFrame: FigmaFrameContext = {
      ...heroFrame,
      layout: {
        name: 'Asymmetric',
        paddingTop: 8, paddingRight: 16, paddingBottom: 24, paddingLeft: 32,
      },
    };
    const out = buildFigmaContextSection([asymFrame]);

    out.includes('pad:8px 16px 24px 32px')
      ? pass('pad:8px 16px 24px 32px emitted for asymmetric padding')
      : fail('asymmetric padding annotation missing or wrong', out.slice(0, 300));
  }

  console.log(chalk.bold.cyan('\nTest 6: empty frames array returns empty string'));
  {
    const out = buildFigmaContextSection([]);

    out === ''
      ? pass('empty frames array returns empty string')
      : fail('expected empty string', JSON.stringify(out.slice(0, 100)));
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: buildFigmaContextSection emits indented layout tree');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
