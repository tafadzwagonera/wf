/**
 * Manual Test Script for the consolidated --repos option
 *
 * Run: nr test:manual repos-option.smoke.ts
 *
 * Verifies that:
 *   1. issue:fetch --help shows -r, --repos <repos...> and NOT --repo or --affected-repos
 *   2. issue:plan --help shows -r, --repos <repos...>
 *   3. issue:implement --help shows -r, --repos <repos...>
 *   4. issue:review --help shows -r, --repos <repos...>
 *   5. issue --help shows -r, --repos <repos...>
 *   6. issue:generate --help shows -r, --repos <repos...>
 *   7. Help text describes repos as space-separated, not comma-separated
 *   8. None of the above show the old --repo / --affected-repositories flags
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function helpOutput(command: string): string {
  const distMain = path.join(__dirname, '../../dist/main.js');
  try {
    return execSync(`node ${distMain} ${command} --help`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
    });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function checkReposFlag(cmd: string, help: string): void {
  if (help.includes('-r, --repos <repos...>')) {
    pass(`${cmd}: -r, --repos <repos...> present in --help`);
  } else {
    fail(`${cmd}: -r, --repos <repos...> NOT found in --help`);
  }
}

function checkSpaceSeparated(cmd: string, help: string): void {
  if (/Space-separated(?: list of)? repositories/.test(help)) {
    pass(`${cmd}: help text describes repos as space-separated`);
  } else {
    fail(`${cmd}: help text does not describe repos as space-separated`);
  }
}

function checkNoCommaSeparated(cmd: string, help: string): void {
  if (help.includes('Comma-separated list of repositories')) {
    fail(`${cmd}: old comma-separated wording still present in --help`);
  } else {
    pass(`${cmd}: old comma-separated wording correctly absent`);
  }
}

function checkNoOldRepoFlag(cmd: string, help: string): void {
  if (help.includes('--repo ') || (/--repo\b(?!s)/.exec(help))) {
    fail(`${cmd}: old --repo flag still present in --help`);
  } else {
    pass(`${cmd}: old --repo flag correctly absent`);
  }
}

function checkNoOldAffectedFlag(cmd: string, help: string): void {
  if (help.includes('--affected-repositories')) {
    fail(`${cmd}: old --affected-repositories flag still present in --help`);
  } else {
    pass(`${cmd}: old --affected-repositories flag correctly absent`);
  }
}

function main(): void {
  console.log('🧪 Testing consolidated --repos option\n');
  const commands = ['issue:fetch', 'issue:plan', 'issue:implement', 'issue:review', 'issue', 'issue:generate'];
  for (const cmd of commands) {
    const help = helpOutput(cmd);
    checkReposFlag(cmd, help);
    checkSpaceSeparated(cmd, help);
    checkNoCommaSeparated(cmd, help);
    checkNoOldRepoFlag(cmd, help);
    checkNoOldAffectedFlag(cmd, help);
  }
  summarise(counts);
}

main();
