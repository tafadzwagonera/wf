/**
 * Manual smoke test: hasUiEnvironment is false for a backend repo with no UI files
 *
 * Verifies that detectDesignSystemContext returns hasUiEnvironment: false for a
 * NestJS-style repo that has a src/ directory and .ts source files but no
 * .tsx / .vue / .jsx files and no UI framework or component-library dependencies.
 * Before the fix, patterns.length was always 4 (one entry per uiPatternSignatures
 * member regardless of found: true/false), so hasUiEnvironment was true for any
 * repo with src/. The fix uses patterns.some(p => p.found) instead.
 *
 * Run: nr test:manual -- has-ui-environment-non-ui-backend-repo.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { detectRepoConventions } from '../../src/shared/utils/detect-repo-conventions';
import { resolvePostParseFigmaLinks } from '../../src/shared/utils/extract-figma-links';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeBackendRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-backend-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'api', dependencies: { '@nestjs/core': '^10.0.0' } }),
  );
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.module.ts'), 'export class AppModule {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'async function bootstrap() {}\nbootstrap();\n');
  return dir;
}

async function main(): Promise<void> {
  console.log('Manual smoke: hasUiEnvironment is false for a backend repo with no UI files\n');

  const dir = makeBackendRepo();

  try {
    const ctx = detectRepoConventions(dir);
    const ds = ctx.designSystem;
    const ticketContent = '# Fix database connection timeout in the auth service';
    const conventions = ctx;

    console.log(chalk.bold.cyan('\nTest 1: hasUiEnvironment is false'));

    if (ds?.hasUiEnvironment === false) {
      pass('hasUiEnvironment: false — backend repo with src/ but no UI files is not a UI environment');
    } else {
      fail('hasUiEnvironment is unexpectedly true', JSON.stringify({ framework: ds?.framework, componentLibrary: ds?.componentLibrary, tailwindConfig: ds?.tailwindConfig, patternCount: ds?.interactionPatterns?.length }));
    }

    console.log(chalk.bold.cyan('\nTest 2: interactionPatterns still emits all 4 signature entries with found: false'));

    const patterns = ds?.interactionPatterns ?? [];
    const allNotFound = patterns.every(p => p.found === false);

    if (patterns.length === 4 && allNotFound) {
      pass(`interactionPatterns length = 4, all found: false — map() still emits one entry per signature`);
    } else {
      fail(`Unexpected interactionPatterns state`, JSON.stringify(patterns));
    }

    console.log(chalk.bold.cyan('\nTest 3: resolvePostParseFigmaLinks returns [] (allowPrompt: false)'));

    const linksNoPrompt = await resolvePostParseFigmaLinks(
      ticketContent, [], { allowPrompt: false, conventions }
    );

    if (linksNoPrompt.length === 0) {
      pass('resolvePostParseFigmaLinks returns [] — hasUiEnvironment gate short-circuits');
    } else {
      fail('Expected [] but got links', JSON.stringify(linksNoPrompt));
    }

    console.log(chalk.bold.cyan('\nTest 4: resolvePostParseFigmaLinks returns [] (allowPrompt: true) — prompt never reached'));

    const linksAllowPrompt = await resolvePostParseFigmaLinks(
      ticketContent, [], { allowPrompt: true, conventions }
    );

    if (linksAllowPrompt.length === 0) {
      pass('resolvePostParseFigmaLinks returns [] even with allowPrompt: true — gate prevents inquirer call');
    } else {
      fail('Expected [] but got links with allowPrompt: true', JSON.stringify(linksAllowPrompt));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: hasUiEnvironment is false for a backend repo');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
