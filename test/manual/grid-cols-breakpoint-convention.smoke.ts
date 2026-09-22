/**
 * Manual smoke test: detectRepoConventions surfaces grid-cols-* breakpoint tiers
 * as a class convention with breakpoint-ordered modalClasses
 *
 * Verifies that Vue files containing Tailwind responsive grid-cols utilities
 * (e.g. grid-cols-1 sm:grid-cols-2 lg:grid-cols-3) produce a grid-cols entry in
 * classConventions with modalClasses sorted in breakpoint order, and that
 * fewer than 3 tokens or fewer than 3 matching files suppress the entry.
 *
 * Run: nr test:manual grid-cols-breakpoint-convention.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
} from '../../src/shared/utils/detect-repo-conventions';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-gcols-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
  return dir;
}

function writeVue(dir: string, name: string, content: string): void {
  const appDir = path.join(dir, 'app');
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, name + '.vue'), content);
}

function assertVariantAProperties(conv: any): void {
  if (conv?.confidence === 'high') {
    pass('Variant A: confidence = "high"');
  } else {
    fail('Variant A: wrong confidence', conv?.confidence);
  }
  if (conv?.modalClasses === 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3') {
    pass('Variant A: modalClasses in breakpoint order');
  } else {
    fail('Variant A: wrong modalClasses', conv?.modalClasses);
  }
}

function checkVariantAConvention(conv: any, ctx: any): void {
  if (conv) {
    pass('Variant A: grid-cols convention detected');
  } else {
    fail('Variant A: grid-cols convention missing', JSON.stringify(ctx.designSystem?.classConventions));
  }
  assertVariantAProperties(conv);
}

function checkVariantAPrompt(ctx: any): void {
  const output = formatRepoConventionsPromptSection(ctx, 'test-repo');
  if (/grid-cols.*sm:grid-cols-2.*lg:grid-cols-3/.test(output)) {
    pass('Variant A: prompt includes grid-cols breakpoint line');
  } else {
    fail('Variant A: prompt missing grid-cols line', output.slice(0, 400));
  }
}

function checkVariantA(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant A: 3 files with 3 grid-cols-* tokens each → high-confidence grid-cols convention'));
  const dir = makeRepo();
  repos.push(dir);
  for (const n of ['A', 'B', 'C']) {
    writeVue(dir, n, `<template><div class="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">${n}</div></template>`);
  }
  const ctx = detectRepoConventions(dir);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-cols');
  checkVariantAConvention(conv, ctx);
  checkVariantAPrompt(ctx);
}

function checkVariantB(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant B: source order scrambled → modalClasses still breakpoint-sorted'));
  const dir = makeRepo();
  repos.push(dir);
  writeVue(dir, 'A', '<template><div class="sm:grid-cols-2 grid-cols-1 lg:grid-cols-3">A</div></template>');
  writeVue(dir, 'B', '<template><div class="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">B</div></template>');
  writeVue(dir, 'C', '<template><div class="lg:grid-cols-3 sm:grid-cols-2 grid-cols-1">C</div></template>');
  const ctx = detectRepoConventions(dir);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-cols');
  if (conv?.modalClasses === 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3') {
    pass('Variant B: breakpoint sort applied regardless of source order');
  } else {
    fail('Variant B: modalClasses not breakpoint-sorted', conv?.modalClasses);
  }
}

function checkVariantC(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant C: only 2 grid-cols-* tokens per file → no grid-cols entry emitted'));
  const dir = makeRepo();
  repos.push(dir);
  for (const n of ['A', 'B', 'C']) {
    writeVue(dir, n, `<template><div class="grid-cols-1 sm:grid-cols-2">${n}</div></template>`);
  }
  const ctx = detectRepoConventions(dir);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-cols');
  if (conv) {
    fail('Variant C: grid-cols should not appear for only 2 tokens', JSON.stringify(conv));
  } else {
    pass('Variant C: grid-cols absent when fewer than 3 tokens per file');
  }
}

function checkVariantD(repos: string[]): void {
  console.log(chalk.bold.cyan('\nVariant D: gap-* and bare grid tokens do not produce a grid-cols entry'));
  const dir = makeRepo();
  repos.push(dir);
  for (const n of ['A', 'B', 'C']) {
    writeVue(dir, n, `<template><div class="grid gap-4 grid-cols-3">${n}</div></template>`);
  }
  const ctx = detectRepoConventions(dir);
  const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-cols');
  if (conv) {
    fail('Variant D: grid-cols entry should not appear from bare grid+gap-4 content', JSON.stringify(conv));
  } else {
    pass('Variant D: gap-* and bare grid tokens produce no grid-cols entry');
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: grid-cols-* breakpoint convention detection\n');
  const repos: string[] = [];
  try {
    checkVariantA(repos);
    checkVariantB(repos);
    checkVariantC(repos);
    checkVariantD(repos);
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
