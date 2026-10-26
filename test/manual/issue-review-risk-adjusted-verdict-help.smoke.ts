/**
 * Manual smoke test: issue:review help documents the risk-adjusted severity verdict rule
 *
 * Run: nr test:manual issue-review-risk-adjusted-verdict-help.smoke
 *
 * Verifies:
 *   1. `issue:review --help` describes the verdict as following risk-adjusted severity
 *   2. `issue:review --help` defines risk as a probability from 0 to 1
 *   3. `issue:review --help` no longer contains the stale severity-only verdict sentence
 *   4. docs/commands-help.catalog.json carries the same risk-adjusted wording for issue:review
 *
 * Wire up: runs the compiled CLI (`dist/main.js`) with cwd set to os.tmpdir()
 * to prove no repo-local state is required. Build first (`yarn build`) so the
 * compiled help reflects the current command description.
 * Teardown: none — the test is read-only against dist/ and docs/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');
const catalogPath = path.join(projectRoot, 'docs', 'commands-help.catalog.json');

const STALE_VERDICT_SENTENCE = 'The verdict follows severity:';

const normalizeWhitespace = (text: string): string => text.replaceAll(/\s+/g, ' ');

function getHelpOutput(): string {
  try {
    return execSync(`node ${distMainPath} issue:review --help`, { encoding: 'utf-8', cwd: os.tmpdir() });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function checkHelpMentionsRiskAdjustedVerdict(help: string): void {
  if (help.includes('The verdict follows risk-adjusted severity')) {
    pass('issue:review --help describes the risk-adjusted severity verdict');
  } else {
    fail('issue:review --help does NOT mention the risk-adjusted severity verdict', help.slice(0, 300));
  }
}

function checkHelpDefinesRiskProbability(help: string): void {
  if (help.includes('the probability, 0 to 1, that it manifests in reality')) {
    pass('issue:review --help defines risk as a probability from 0 to 1');
  } else {
    fail('issue:review --help does NOT define risk as a probability from 0 to 1');
  }
}

function checkHelpDropsStaleSentence(help: string): void {
  if (help.includes(STALE_VERDICT_SENTENCE)) {
    fail('issue:review --help still contains the stale severity-only verdict sentence');
  } else {
    pass('issue:review --help no longer contains the stale severity-only verdict sentence');
  }
}

function readCatalogDescription(): string | null {
  if (!fs.existsSync(catalogPath)) return null;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  return normalizeWhitespace(String(catalog['issue:review']?.description ?? ''));
}

function findCatalogDescriptionProblem(description: string): string | null {
  if (!description.includes('The verdict follows risk-adjusted severity')) {
    return 'help catalog lacks the risk-adjusted severity verdict wording for issue:review';
  }
  if (description.includes(STALE_VERDICT_SENTENCE)) {
    return 'help catalog still contains the stale severity-only verdict sentence for issue:review';
  }
  return null;
}

function checkCatalogMatchesHelp(): void {
  const description = readCatalogDescription();
  if (description === null) {
    fail('docs/commands-help.catalog.json is missing', catalogPath);
    return;
  }
  const problem = findCatalogDescriptionProblem(description);
  if (problem) {
    fail(problem);
    return;
  }
  pass('help catalog carries the risk-adjusted verdict wording and no stale sentence');
}

function checkDistExists(): void {
  if (fs.existsSync(distMainPath)) return;
  fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\nissue:review risk-adjusted verdict help\n');
  checkDistExists();
  const help = normalizeWhitespace(getHelpOutput());
  checkHelpMentionsRiskAdjustedVerdict(help);
  checkHelpDefinesRiskProbability(help);
  checkHelpDropsStaleSentence(help);
  checkCatalogMatchesHelp();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
