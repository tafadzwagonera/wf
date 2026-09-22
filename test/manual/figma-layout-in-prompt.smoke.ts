/**
 * Manual smoke test: buildFigmaContextSection emits indented layout tree in prompt text
 *
 * Verifies that the prompt section includes the frame header (URL, name, screenshot)
 * followed by a "Layout:" block with indented property annotations for fills, padding,
 * gap, cornerRadius, typography, and text. Multiple frames are separated by "---".
 *
 * Run: nr test:manual figma-layout-in-prompt.smoke.ts
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

function checkCondition(condition: boolean, passMsg: string, failMsg: string, snippet: string): void {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg, snippet);
  }
}

function checkContains(out: string, needle: string, passMsg: string, failMsg: string, snippetLen = 200): void {
  checkCondition(out.includes(needle), passMsg, failMsg, out.slice(0, snippetLen));
}

function runTest1FrameHeaderFields(): void {
  console.log(chalk.bold.cyan('\nTest 1: frame header fields present'));
  const out = buildFigmaContextSection([heroFrame]);
  checkContains(out, `Frame: ${HERO_URL}`, 'output includes Frame URL', 'Frame URL missing');
  checkContains(out, 'Name: Hero (1440×900px)', 'output includes Name line with dimensions', 'Name line missing or wrong');
  checkContains(out, 'Screenshot: https://s3.example.com/hero.png', 'Screenshot URL present', 'Screenshot line missing');
  checkContains(out, 'Layout:', 'output includes "Layout:" section header', '"Layout:" header missing', 300);
}

function runTest2LayoutAnnotations(): void {
  console.log(chalk.bold.cyan('\nTest 2: layout annotations — layoutMode, padding, gap, fill'));
  const out = buildFigmaContextSection([heroFrame]);
  checkCondition(
    /hero.*horizontal/i.test(out),
    'layoutMode "horizontal" appears after node name',
    'layoutMode "horizontal" missing',
    out.slice(0, 400),
  );
  checkContains(out, 'pad:32px', 'pad:32px emitted (all sides equal → compact form)', 'pad:32px missing', 400);
  checkContains(out, 'gap:24px', 'gap:24px present', 'gap:24px missing', 400);
  checkContains(out, 'fill:#ffffff', 'fill:#ffffff present', 'fill:#ffffff missing', 400);
}

function runTest3ChildNodeTypography(): void {
  console.log(chalk.bold.cyan('\nTest 3: child node with typography and text annotation'));
  const out = buildFigmaContextSection([heroFrame]);
  checkContains(out, 'Headline (600×80px)', 'child "Headline" with dimensions emitted', 'child "Headline" missing', 500);
  checkContains(out, '[font:48px w700 lh:56px]', '[font:48px w700 lh:56px] present', '[font:...] annotation wrong', 500);
  checkContains(
    out,
    '[text:"Welcome to the platform"]',
    '[text:"Welcome to the platform"] present',
    '[text:...] missing',
    500,
  );
}

function runTest4MultiFrameSeparator(): void {
  console.log(chalk.bold.cyan('\nTest 4: multi-frame output separated by "---"'));
  const out = buildFigmaContextSection([heroFrame, mobileFrame]);
  checkContains(out, '---', '"---" separator present between frames', '"---" separator missing');
  checkContains(out, `Frame: ${MOBILE_URL}`, 'second frame URL present', 'second frame URL missing', 400);
  checkContains(out, 'Name: Mobile (390×844px)', 'second frame name and dims present', 'second frame name/dims wrong', 400);
}

function runTest5AsymmetricPadding(): void {
  console.log(chalk.bold.cyan('\nTest 5: asymmetric padding uses full four-value form'));
  const asymFrame: FigmaFrameContext = {
    ...heroFrame,
    layout: { name: 'Asymmetric', paddingTop: 8, paddingRight: 16, paddingBottom: 24, paddingLeft: 32 },
  };
  const out = buildFigmaContextSection([asymFrame]);
  checkContains(out, 'pad:8px 16px 24px 32px', 'asymmetric padding emitted', 'asymmetric padding wrong', 300);
}

function runTest6EmptyFrames(): void {
  console.log(chalk.bold.cyan('\nTest 6: empty frames array returns empty string'));
  const out = buildFigmaContextSection([]);
  checkCondition(
    out === '',
    'empty frames array returns empty string',
    'expected empty string',
    JSON.stringify(out.slice(0, 100)),
  );
}

async function main(): Promise<void> {
  console.log('Manual smoke: buildFigmaContextSection emits indented layout tree\n');
  runTest1FrameHeaderFields();
  runTest2LayoutAnnotations();
  runTest3ChildNodeTypography();
  runTest4MultiFrameSeparator();
  runTest5AsymmetricPadding();
  runTest6EmptyFrames();
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: buildFigmaContextSection emits indented layout tree');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
