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
 * Run: nr test:manual has-ui-environment-non-ui-backend-repo.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { detectRepoConventions } from '../../src/common/utils/detect-repo-conventions';
import { resolvePostParseFigmaLinks } from '../../src/common/utils/extract-figma-links';
import { createReporter, summarise } from './support/reporter';

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

function checkHasUiEnvironmentFalse(ds: any): void {
  if (ds?.hasUiEnvironment === false) {
    pass('hasUiEnvironment: false — backend repo with src/ but no UI files is not a UI environment');
  } else {
    fail('hasUiEnvironment is unexpectedly true', JSON.stringify({ framework: ds?.framework, componentLibrary: ds?.componentLibrary, tailwindConfig: ds?.tailwindConfig, patternCount: ds?.interactionPatterns?.length }));
  }
}

function checkInteractionPatterns(ds: any): void {
  const patterns = ds?.interactionPatterns ?? [];
  const allNotFound = patterns.every((p: any) => p.found === false);
  if (patterns.length === 4 && allNotFound) {
    pass(`interactionPatterns length = 4, all found: false — map() still emits one entry per signature`);
  } else {
    fail(`Unexpected interactionPatterns state`, JSON.stringify(patterns));
  }
}

async function checkFigmaLinksNoPrompt(ticketContent: string, conventions: any): Promise<void> {
  const linksNoPrompt = await resolvePostParseFigmaLinks(
    ticketContent, [], { allowPrompt: false, conventions }
  );
  if (linksNoPrompt.length === 0) {
    pass('resolvePostParseFigmaLinks returns [] — hasUiEnvironment gate short-circuits');
  } else {
    fail('Expected [] but got links', JSON.stringify(linksNoPrompt));
  }
}

async function checkFigmaLinksAllowPrompt(ticketContent: string, conventions: any): Promise<void> {
  const linksAllowPrompt = await resolvePostParseFigmaLinks(
    ticketContent, [], { allowPrompt: true, conventions }
  );
  if (linksAllowPrompt.length === 0) {
    pass('resolvePostParseFigmaLinks returns [] even with allowPrompt: true — gate prevents inquirer call');
  } else {
    fail('Expected [] but got links with allowPrompt: true', JSON.stringify(linksAllowPrompt));
  }
}

async function runAllTests(dir: string): Promise<void> {
  const ctx = detectRepoConventions(dir);
  const ds = ctx.designSystem;
  const ticketContent = '# Fix database connection timeout in the auth service';
  console.log(chalk.bold.cyan('\nTest 1: hasUiEnvironment is false'));
  checkHasUiEnvironmentFalse(ds);
  console.log(chalk.bold.cyan('\nTest 2: interactionPatterns still emits all 4 signature entries with found: false'));
  checkInteractionPatterns(ds);
  console.log(chalk.bold.cyan('\nTest 3: resolvePostParseFigmaLinks returns [] (allowPrompt: false)'));
  await checkFigmaLinksNoPrompt(ticketContent, ctx);
  console.log(chalk.bold.cyan('\nTest 4: resolvePostParseFigmaLinks returns [] (allowPrompt: true) — prompt never reached'));
  await checkFigmaLinksAllowPrompt(ticketContent, ctx);
}

async function main(): Promise<void> {
  console.log('Manual smoke: hasUiEnvironment is false for a backend repo with no UI files\n');
  const dir = makeBackendRepo();
  try {
    await runAllTests(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
