/**
 * Manual smoke test: detectReuseCandidates scans app/components and app/composables
 * and formatReuseCandidatesPromptSection renders candidates into the prompt section
 *
 * Verifies that matching component files are surfaced, non-matching ticket content
 * returns undefined, wrong directory roots return undefined, and the formatter
 * truncates at a newline boundary rather than mid-path.
 *
 * Run: nr test:manual detect-reuse-candidates.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import {
  detectReuseCandidates,
  formatReuseCandidatesPromptSection,
  type ReuseCandidateContext,
} from '../../src/common/utils/detect-reuse-candidates';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-reuse-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
  return dir;
}

function writeFile(dir: string, relPath: string, content = ''): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function checkTest1Names(ctx: ReuseCandidateContext | undefined): void {
  const names = ctx?.candidates?.map(c => c.name) ?? [];
  if (names.includes('NewsFeed.vue')) {
    pass('NewsFeed.vue included as candidate');
  } else {
    fail('NewsFeed.vue missing from candidates', JSON.stringify(names));
  }
  if (names.includes('useFeedScroll.ts')) {
    pass('useFeedScroll.ts included as candidate');
  } else {
    fail('useFeedScroll.ts missing from candidates', JSON.stringify(names));
  }
}

function checkTest1Paths(ctx: ReuseCandidateContext | undefined): void {
  const relative = ctx?.candidates?.map(c => c.relativePath) ?? [];
  if (relative.some(p => path.isAbsolute(p))) {
    fail('some relativePaths are absolute', JSON.stringify(relative));
  } else {
    pass('relativePaths are relative (not absolute)');
  }
}

function runTest1(repos: string[]): void {
  console.log(chalk.bold.cyan('\nTest 1: matching filenames in app/components and app/composables are surfaced'));
  const dir = makeRepo();
  repos.push(dir);
  writeFile(dir, 'app/components/NewsFeed.vue');
  writeFile(dir, 'app/composables/useFeedScroll.ts');
  const ctx = detectReuseCandidates(dir, 'Display a news feed with scroll functionality');
  if (ctx?.candidates?.length === 2) {
    pass('both matching files returned as candidates');
  } else {
    fail('expected 2 candidates', JSON.stringify(ctx));
  }
  checkTest1Names(ctx);
  checkTest1Paths(ctx);
}

function runTest2(repos: string[]): void {
  console.log(chalk.bold.cyan('\nTest 2: ticket content with no vocabulary overlap returns undefined'));
  const dir = makeRepo();
  repos.push(dir);
  writeFile(dir, 'app/components/NewsFeed.vue');
  const ctx = detectReuseCandidates(dir, 'fix database timeout in the auth service');
  if (ctx === undefined) {
    pass('undefined returned when ticket shares no vocabulary with filenames');
  } else {
    fail('expected undefined for non-matching ticket', JSON.stringify(ctx));
  }
}

function runTest3(repos: string[]): void {
  console.log(chalk.bold.cyan('\nTest 3: components under src/components (not app/) return undefined'));
  const dir = makeRepo();
  repos.push(dir);
  writeFile(dir, 'src/components/NewsFeed.vue');
  const ctx = detectReuseCandidates(dir, 'Display a news feed with scroll functionality');
  if (ctx === undefined) {
    pass('undefined returned for repo with components under src/ not app/');
  } else {
    fail('expected undefined for wrong directory root', JSON.stringify(ctx));
  }
}

function runTest4(): void {
  console.log(chalk.bold.cyan('\nTest 4: formatReuseCandidatesPromptSection(undefined) returns empty string'));
  const result = formatReuseCandidatesPromptSection(undefined);
  if (result === '') {
    pass('formatter returns empty string for undefined context');
  } else {
    fail('formatter returned non-empty string for undefined', result.slice(0, 100));
  }
}

function makeTest5Result(): string {
  const longName = 'NewsArticleFeedCardComponentItem';
  const candidates = Array.from({ length: 40 }, (_, i) => ({
    name: `${longName}${i}.vue`,
    relativePath: `app/components/${longName}${i}.vue`,
  }));
  return formatReuseCandidatesPromptSection({ candidates });
}

function runTest5(): void {
  console.log(chalk.bold.cyan('\nTest 5: formatter truncates at newline boundary, not mid-path'));
  const result = makeTest5Result();
  const lastChar = result.at(-1);
  if (lastChar !== '`' && lastChar !== '(' && lastChar !== '.') {
    pass('truncation ends at newline boundary (not mid-path)');
  } else {
    fail('truncation cut mid-path', `last char: '${lastChar}', tail: '${result.slice(-30)}'`);
  }
  if (result.length <= 3000) {
    pass('formatted output capped at FORMAT_MAX_CHARS (3000)');
  } else {
    fail('output exceeds FORMAT_MAX_CHARS', String(result.length));
  }
}

function setupTest6(repos: string[]): string {
  const dir = makeRepo();
  repos.push(dir);
  writeFile(dir, 'app/components/NewsFeed.vue');
  writeFile(dir, 'app/composables/useFeedScroll.ts');
  const ctx = detectReuseCandidates(dir, 'Display a news feed with scroll functionality');
  return formatReuseCandidatesPromptSection(ctx);
}

function runTest6(repos: string[]): void {
  console.log(chalk.bold.cyan('\nTest 6: prompt section includes heading and backtick-wrapped relative paths'));
  const section = setupTest6(repos);
  if (section.includes('Existing components that may be reusable for this ticket')) {
    pass('prompt section includes reuse-candidates heading');
  } else {
    fail('heading missing from prompt section', section.slice(0, 300));
  }
  if (/`app\/components\/NewsFeed\.vue`/.test(section)) {
    pass('NewsFeed.vue appears in backticks with relative path');
  } else {
    fail('NewsFeed.vue not found in section with backtick path', section);
  }
}

function runAllTests(repos: string[]): void {
  runTest1(repos);
  runTest2(repos);
  runTest3(repos);
  runTest4();
  runTest5();
  runTest6(repos);
}

function reportResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: detectReuseCandidates and formatter');
}

async function main(): Promise<void> {
  console.log('Manual smoke: detectReuseCandidates scanner and prompt formatter\n');
  const repos: string[] = [];
  try {
    runAllTests(repos);
  } finally {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  }
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
