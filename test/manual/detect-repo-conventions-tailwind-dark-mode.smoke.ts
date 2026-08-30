/**
 * Manual smoke test: detectTailwindConfig and detectDarkModeConvention populate
 * the design system context with tailwind mode and dark mode convention
 *
 * Verifies that detectRepoConventions now returns non-null tailwindConfig and
 * darkModeConvention fields instead of always returning null. Before this
 * change both fields were always null regardless of the repo's Tailwind setup.
 *
 * Variants:
 *   A. tailwind.config.ts with darkMode: 'class' → legacy-file + tailwind-dark
 *   B. Global CSS with @theme directive → inline-theme, no dark mode
 *   C. Global CSS with [data-theme attribute → css-variables + data-theme-attr
 *   D. No Tailwind at all → both fields null
 *
 * Run: nr test:manual -- detect-repo-conventions-tailwind-dark-mode.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
} from '../../src/shared/utils/detect-repo-conventions';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  PASS  ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(chalk.red(`  FAIL  ${msg}${detail ? `\n    → ${detail}` : ''}`));
  failed++;
};

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tw-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { tailwindcss: '^4.0.0' } }));
  return dir;
}

async function main(): Promise<void> {
  console.log('Manual smoke: detectTailwindConfig and detectDarkModeConvention\n');

  const repos: string[] = [];

  try {
    console.log(chalk.bold.cyan('\nVariant A: tailwind.config.ts with darkMode: "class" → legacy-file + tailwind-dark'));
    {
      const dir = makeRepo();
      repos.push(dir);
      fs.writeFileSync(
        path.join(dir, 'tailwind.config.ts'),
        `import type { Config } from 'tailwindcss';\nexport default { darkMode: 'class', content: [] } satisfies Config;\n`,
      );
      const ctx = detectRepoConventions(dir);
      const tc = ctx.designSystem?.tailwindConfig;
      const dm = ctx.designSystem?.darkModeConvention;

      if (tc?.mode === 'legacy-file') {
        pass(`Variant A: tailwindConfig.mode = 'legacy-file' (path: ${tc.path})`);
      } else {
        fail(`Variant A: expected tailwindConfig.mode 'legacy-file', got '${tc?.mode ?? 'null'}'`);
      }

      if (dm === 'tailwind-dark') {
        pass(`Variant A: darkModeConvention = 'tailwind-dark'`);
      } else {
        fail(`Variant A: expected darkModeConvention 'tailwind-dark', got '${dm ?? 'null'}'`);
      }

      const section = formatRepoConventionsPromptSection(ctx, 'test-repo-a');
      if (section.includes('tailwind:legacy-file')) {
        pass('Variant A: conventions section includes tailwind:legacy-file');
      } else {
        fail('Variant A: conventions section missing tailwind:legacy-file', section);
      }
      if (section.includes('tailwind-dark')) {
        pass('Variant A: conventions section includes tailwind-dark');
      } else {
        fail('Variant A: conventions section missing tailwind-dark', section);
      }
    }

    console.log(chalk.bold.cyan('\nVariant B: global CSS with @theme → inline-theme, no dark mode'));
    {
      const dir = makeRepo();
      repos.push(dir);
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app', 'globals.css'),
        `@import 'tailwindcss';\n@theme {\n  --color-primary: #0070f3;\n}\n`,
      );
      const ctx = detectRepoConventions(dir);
      const tc = ctx.designSystem?.tailwindConfig;
      const dm = ctx.designSystem?.darkModeConvention;

      if (tc?.mode === 'inline-theme') {
        pass(`Variant B: tailwindConfig.mode = 'inline-theme' (path: ${tc.path})`);
      } else {
        fail(`Variant B: expected tailwindConfig.mode 'inline-theme', got '${tc?.mode ?? 'null'}'`);
      }

      if (dm == null) {
        pass('Variant B: darkModeConvention = null (no dark mode in CSS)');
      } else {
        fail(`Variant B: expected darkModeConvention null, got '${dm}'`);
      }
    }

    console.log(chalk.bold.cyan('\nVariant C: global CSS with [data-theme → css-variables + data-theme-attr'));
    {
      const dir = makeRepo();
      repos.push(dir);
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app', 'globals.css'),
        `:root { --color-bg: #fff; }\n@config './tailwind.config.js';\n[data-theme="dark"] { --color-bg: #000; }\n`,
      );
      const ctx = detectRepoConventions(dir);
      const tc = ctx.designSystem?.tailwindConfig;
      const dm = ctx.designSystem?.darkModeConvention;

      if (tc?.mode === 'css-variables') {
        pass(`Variant C: tailwindConfig.mode = 'css-variables' (path: ${tc.path})`);
      } else {
        fail(`Variant C: expected tailwindConfig.mode 'css-variables', got '${tc?.mode ?? 'null'}'`);
      }

      if (dm === 'data-theme-attr') {
        pass(`Variant C: darkModeConvention = 'data-theme-attr'`);
      } else {
        fail(`Variant C: expected darkModeConvention 'data-theme-attr', got '${dm ?? 'null'}'`);
      }
    }

    console.log(chalk.bold.cyan('\nVariant D: no Tailwind at all → both fields null'));
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-notw-'));
      repos.push(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }));
      const ctx = detectRepoConventions(dir);
      const tc = ctx.designSystem?.tailwindConfig;
      const dm = ctx.designSystem?.darkModeConvention;

      if (tc == null) {
        pass('Variant D: tailwindConfig = null');
      } else {
        fail(`Variant D: expected tailwindConfig null, got mode '${tc.mode}'`);
      }

      if (dm == null) {
        pass('Variant D: darkModeConvention = null');
      } else {
        fail(`Variant D: expected darkModeConvention null, got '${dm}'`);
      }
    }
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: detectTailwindConfig and detectDarkModeConvention');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
