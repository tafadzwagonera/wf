/**
 * Manual smoke test: element class-convention miner populates classConventions
 * and renders them in the plan prompt
 *
 * Verifies that detectRepoConventions reads real .vue files from the filesystem,
 * aggregates heading and grid-gap class samples, and populates
 * designSystem.classConventions with the correct confidence, occurrence count,
 * and modal class string. Also confirms that the prompt section rendered by
 * formatRepoConventionsPromptSection includes the "Element class conventions"
 * heading and the per-element lines in the expected format.
 *
 * Run: nr test:manual element-class-convention-miner.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
} from '../../src/shared/utils/detect-repo-conventions';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

type DesignCtx = ReturnType<typeof detectRepoConventions>;
type ClassConvention = NonNullable<DesignCtx['designSystem']>['classConventions'][0];

function makeRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-class-conv-' + name + '-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
  return dir;
}

function writeVue(dir: string, name: string, content: string): void {
  const appDir = path.join(dir, 'app');
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, name + '.vue'), content);
}

function checkVariantAConvention(ctx: DesignCtx): void {
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h2');
  if (conv) {
    pass('Variant A: h2 convention detected');
  } else {
    fail('Variant A: h2 convention not found', JSON.stringify(ctx.designSystem?.classConventions));
  }
  if (conv?.modalClasses === 'font-bold text-2xl') {
    pass('Variant A: modalClasses = "font-bold text-2xl"');
  } else {
    fail('Variant A: wrong modalClasses', conv?.modalClasses);
  }
  checkVariantAStats(conv);
}

function checkVariantAConfidence(conv: ClassConvention | undefined): void {
  if (conv?.confidence === 'high') {
    pass('Variant A: confidence = "high"');
  } else {
    fail('Variant A: wrong confidence', conv?.confidence);
  }
}

function checkVariantAOccurrencesAndSamples(conv: ClassConvention | undefined): void {
  if (conv?.occurrences === 3) {
    pass('Variant A: occurrences = 3');
  } else {
    fail('Variant A: wrong occurrences', String(conv?.occurrences));
  }
  if (conv?.totalSamples === 3) {
    pass('Variant A: totalSamples = 3');
  } else {
    fail('Variant A: wrong totalSamples', String(conv?.totalSamples));
  }
}

function checkVariantAStats(conv: ClassConvention | undefined): void {
  checkVariantAConfidence(conv);
  checkVariantAOccurrencesAndSamples(conv);
}

function checkVariantAPromptLine(output: string): void {
  if (/h2.*"font-bold text-2xl".*\(3\/3/.test(output)) {
    pass(String.raw`Variant A: prompt line matches /h2.*"font-bold text-2xl".*\(3\/3/`);
  } else {
    const start = output.indexOf('Element class');
    fail('Variant A: prompt line format wrong', output.slice(start, start + 300));
  }
  if (/A\.vue/.test(output)) {
    pass('Variant A: prompt line references source file');
  } else {
    fail('Variant A: prompt line missing file reference');
  }
}

function checkVariantAPrompt(ctx: DesignCtx): void {
  const output = formatRepoConventionsPromptSection(ctx, 'test-repo');
  if (output.includes('Element class conventions')) {
    pass('Variant A: prompt includes "Element class conventions" heading');
  } else {
    fail('Variant A: "Element class conventions" heading absent from prompt');
  }
  checkVariantAPromptLine(output);
}

function runVariantA(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant A: 3 files agree on h2 class → high-confidence convention'));
  const dir = makeRepo('a');
  repos.push(dir);
  for (const n of ['A', 'B', 'C']) {
    writeVue(dir, n, '<template><h2 class="font-bold text-2xl">Title</h2></template>');
  }
  const ctx = detectRepoConventions(dir);
  checkVariantAConvention(ctx);
  checkVariantAPrompt(ctx);
}

function setupVariantB(repos: string[]) {
  const dir = makeRepo('b');
  repos.push(dir);
  for (const n of ['A', 'B']) {
    writeVue(dir, n, '<template><h4 class="font-bold">T</h4></template>');
  }
  return detectRepoConventions(dir);
}

function checkVariantBPrompt(ctx: DesignCtx): void {
  const output = formatRepoConventionsPromptSection(ctx, 'test-repo');
  if (output.includes('Element class conventions')) {
    fail('Variant B: "Element class conventions" unexpectedly present', output.slice(0, 300));
  } else {
    pass('Variant B: "Element class conventions" absent from prompt (no data)');
  }
}

function runVariantB(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant B: 2 files (below threshold) → no convention reported'));
  const ctx = setupVariantB(repos);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h4');
  if (conv) {
    fail('Variant B: h4 should not be reported', JSON.stringify(conv));
  } else {
    pass('Variant B: h4 not reported (fewer than 3 samples)');
  }
  checkVariantBPrompt(ctx);
}

function checkVariantCDetected(conv: ClassConvention | undefined): void {
  if (conv) {
    pass('Variant C: grid-gap convention detected');
  } else {
    fail('Variant C: grid-gap convention not found');
  }
}

function checkVariantCConfidenceAndGap(conv: ClassConvention | undefined): void {
  if (conv?.confidence === 'high') {
    pass('Variant C: confidence = "high"');
  } else {
    fail('Variant C: wrong confidence', conv?.confidence);
  }
  if (conv?.modalClasses.includes('gap-4')) {
    pass('Variant C: modalClasses includes "gap-4"');
  } else {
    fail('Variant C: modalClasses missing "gap-4"', conv?.modalClasses);
  }
}

function checkVariantCGapConvention(conv: ClassConvention | undefined): void {
  checkVariantCDetected(conv);
  checkVariantCConfidenceAndGap(conv);
}

function checkVariantCGapOnly(conv: ClassConvention | undefined): void {
  const hasNonGapToken = (conv?.modalClasses?.includes('grid-cols-3') ?? false)
    || (conv?.modalClasses?.includes('grid ') ?? false)
    || conv?.modalClasses === 'grid';
  if (hasNonGapToken) {
    fail('Variant C: modalClasses contains non-gap tokens', conv?.modalClasses);
  } else {
    pass('Variant C: modalClasses contains only gap-* token (no "grid" or "grid-cols-3")');
  }
}

function runVariantC(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant C: grid-gap detection → modalClasses contains only gap-* token'));
  const dir = makeRepo('c');
  repos.push(dir);
  for (const n of ['A', 'B', 'C']) {
    writeVue(dir, n, '<template><div class="grid gap-4 grid-cols-3">content</div></template>');
  }
  const ctx = detectRepoConventions(dir);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-gap');
  checkVariantCGapConvention(conv);
  checkVariantCGapOnly(conv);
}

function setupVariantD(repos: string[]) {
  const dir = makeRepo('d');
  repos.push(dir);
  writeVue(dir, 'A', '<template><h3 class="text-xl font-semibold">T</h3></template>');
  writeVue(dir, 'B', '<template><h3 class="font-semibold text-xl">T</h3></template>');
  writeVue(dir, 'C', '<template><h3 class="font-semibold text-xl">T</h3></template>');
  return detectRepoConventions(dir);
}

function runVariantD(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant D: class order canonicalisation → same convention despite different attribute order'));
  const ctx = setupVariantD(repos);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h3');
  if (conv?.confidence === 'high') {
    pass('Variant D: different class order canonicalises to high-confidence convention');
  } else {
    fail('Variant D: expected high confidence after canonicalisation', JSON.stringify(conv));
  }
  if (conv?.modalClasses === 'font-semibold text-xl') {
    pass('Variant D: canonical modalClasses = "font-semibold text-xl" (sorted)');
  } else {
    fail('Variant D: wrong canonical modalClasses', conv?.modalClasses);
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: element class-convention miner\n');
  const repos: string[] = [];
  try {
    runVariantA(repos);
    runVariantB(repos);
    runVariantC(repos);
    runVariantD(repos);
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('\n' + counts.passed + ' passed, ' + counts.failed + ' failed');
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: element class-convention miner');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
