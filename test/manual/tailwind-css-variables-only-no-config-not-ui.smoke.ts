/**
 * Manual smoke test: global CSS with only :root/-- does not produce tailwindConfig
 *
 * Verifies that detectTailwindConfig returns null when a global CSS file contains
 * only :root custom properties without an @config or @theme directive. Before the
 * fix, content.includes(':root') && content.includes('--') was sufficient to
 * return { mode: 'css-variables' }, falsely marking generic CSS-variable repos as
 * Tailwind projects. The fix removes that branch; only @config and @theme are
 * accepted as Tailwind signals.
 *
 * detect-repo-conventions-tailwind-dark-mode covers @config and @theme detection;
 * this test focuses only on the false-positive case that was removed.
 *
 * Run: nr test:manual tailwind-css-variables-only-no-config-not-ui.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { detectRepoConventions } from '../../src/shared/utils/detect-repo-conventions';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeRepo(cssContent: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tw-css-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.css'), cssContent);
  return dir;
}

function assertVariantAResults(tc: any, ctx: any): void {
  if (tc === null) {
    pass('Variant A: tailwindConfig is null — :root/-- without @config or @theme is not Tailwind');
  } else {
    fail(`Variant A: expected null, got mode '${tc?.mode}'`);
  }
  if (ctx.designSystem?.hasUiEnvironment === false) {
    pass('Variant A: hasUiEnvironment is false — no UI signals detected');
  } else {
    fail('Variant A: hasUiEnvironment is unexpectedly true');
  }
}

function checkVariantA(repos: string[]): void {
  const dir = makeRepo(':root {\n  --color-bg: #fff;\n  --color-fg: #000;\n}\n');
  repos.push(dir);
  const ctx = detectRepoConventions(dir);
  assertVariantAResults(ctx.designSystem?.tailwindConfig, ctx);
}

async function main(): Promise<void> {
  console.log('Manual smoke: :root/-- only CSS does not produce tailwindConfig\n');
  const repos: string[] = [];
  try {
    console.log(chalk.bold.cyan('\nVariant A: :root { --var } only — no @config, no @theme → tailwindConfig: null'));
    checkVariantA(repos);
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
