/**
 * Manual Test: issue:create's runtime header and -h Examples section stay in sync with dist/
 *
 * Run: nr test:manual issue-create-header-catalog-parity.smoke.ts
 *
 * Verifies that:
 *   1. `wf issue:create --help`'s Examples: section and `wf issue:create --dry-run`'s
 *      Examples: section are byte-identical (after stripping ANSI codes) — both
 *      render via the same shared cli-help-render.ts, but `-h` reads from the
 *      build-time catalog under dist/bootstrap/ while the runtime header reads
 *      the hand-authored registry directly
 *   2. issue:create has exactly 5 registry examples, so the header's 5-cap
 *      renders the same set -h shows, including a long multi-line-wrapped example
 *   3. Deliberately staling dist/bootstrap/commands-help.catalog.json (editing one
 *      example's command text without rebuilding) makes -h's Examples: section
 *      diverge from the runtime header's — proving this test can actually detect
 *      the stale-dist regression it exists to catch, not just pass by construction
 *
 * No AI / API keys required — a nonexistent input file causes a fast, expected
 * failure on --dry-run while the header still prints ahead of it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const CATALOG_PATH = path.join(__dirname, '../../dist/bootstrap/commands-help.catalog.json');
const ANSI_ESCAPE = String.fromCodePoint(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function examplesSection(output: string): string {
  const plain = output.replaceAll(ANSI_PATTERN, '');
  const lines = plain.split('\n');
  const headingIndex = lines.findIndex(line => line.trim() === 'Examples:');
  if (headingIndex === -1) return '';

  const sectionLines = [lines[headingIndex]];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (!/^\s/.test(lines[i])) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n');
}

function checkSectionsParity(helpExamples: string, headerExamples: string): void {
  if (helpExamples.length > 0 && headerExamples.length > 0) {
    pass('Both invocations produced a non-empty Examples: section');
  } else {
    fail('One or both Examples: sections were empty', `help=${helpExamples.length} header=${headerExamples.length}`);
  }
  if (helpExamples === headerExamples) {
    pass('The -h and runtime header Examples: sections are byte-identical');
  } else {
    fail('Examples: sections diverge under a fresh build', `help:\n${helpExamples}\n---\nheader:\n${headerExamples}`);
  }
}

function checkExampleCount(headerExamples: string): void {
  const commandLineCount = headerExamples
    .split('\n')
    .filter(l => l.trimStart().startsWith('wf ') || l.trimStart().startsWith('yarn ')).length;
  if (commandLineCount === 5) {
    pass('Header renders all 5 registry examples for issue:create (no cap truncation)');
  } else {
    fail('Unexpected example count in header', String(commandLineCount));
  }
}

function checkStaleCatalogDetected(originalCatalog: string, headerExamples: string, scratchDir: string): void {
  const mutatedCatalog = originalCatalog.replace('"wf issue:create ticket.json"', '"wf issue:create ticket.json --stale-marker"');
  if (mutatedCatalog === originalCatalog) {
    fail('Could not locate the target example string to mutate in the catalog JSON — test fixture is stale');
    return;
  }
  fs.writeFileSync(CATALOG_PATH, mutatedCatalog, 'utf-8');
  const staleHelpExamples = examplesSection(runCli(['issue:create', '--help'], scratchDir));
  if (staleHelpExamples !== headerExamples && staleHelpExamples.includes('--stale-marker')) {
    pass('A staled dist/ catalog correctly causes -h to diverge from the runtime header (detection works)');
  } else {
    fail('Staling the catalog did not produce a detectable divergence', staleHelpExamples.slice(0, 300));
  }
}

async function runAllChecks(scratchDir: string, originalCatalog: string): Promise<void> {
  const helpOutput = runCli(['issue:create', '--help'], scratchDir);
  const dryRunOutput = runCli(['issue:create', '--dry-run', path.join(scratchDir, 'missing-ticket.json')], scratchDir);
  const helpExamples = examplesSection(helpOutput);
  const headerExamples = examplesSection(dryRunOutput);
  checkSectionsParity(helpExamples, headerExamples);
  checkExampleCount(headerExamples);
  checkStaleCatalogDetected(originalCatalog, headerExamples, scratchDir);
}

async function main(): Promise<void> {
  console.log('\n issue:create header <-> -h catalog parity\n');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-create-header-parity-'));
  const originalCatalog = fs.readFileSync(CATALOG_PATH, 'utf-8');
  try {
    await runAllChecks(scratchDir, originalCatalog);
  } finally {
    fs.writeFileSync(CATALOG_PATH, originalCatalog, 'utf-8');
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
