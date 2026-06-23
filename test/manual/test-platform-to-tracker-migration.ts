/**
 * Manual Test: platform → tracker migration smoke test
 *
 * Run: yarn test:manual -- test-platform-to-tracker-migration
 *
 * Verifies:
 *   1. No source file under src/ exports or references `PlatformService`
 *   2. No source file under src/ uses the `--platform` CLI flag
 *   3. No source file under src/ reads `platforms.primary` from config
 *   4. The old `src/integrations/platforms/` directory no longer exists
 *   5. The new `src/integrations/issue-trackers/` directory contains renamed files
 *   6. The DTO exports `IssueTrackerTicketReference` with a `tracker` field
 *   7. `NormalizedWfConfig` has a `tracker` key (not `platforms`)
 *   8. Help catalog commands expose `--tracker` and not `--platform`
 */

import * as fs from 'fs';
import * as path from 'path';
import { strict as assert } from 'assert';
import { getCommandHelpCatalog } from '../../src/bootstrap/help-catalog-parser';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const collectTsFiles = (dir: string): string[] => {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectTsFiles(full));
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      results.push(full);
    }
  }
  return results;
};

const run = () => {
  console.log('🔍 Smoke test: platform → tracker migration\n');

  // 1. No PlatformService export/reference
  const srcFiles = collectTsFiles(SRC);
  const platformServiceFiles = srcFiles.filter(f => {
    const content = fs.readFileSync(f, 'utf-8');
    return /\bPlatformService\b/.test(content);
  });
  assert.equal(
    platformServiceFiles.length,
    0,
    `PlatformService still referenced in: ${platformServiceFiles.map(f => path.relative(ROOT, f)).join(', ')}`
  );
  console.log('  ✓ No PlatformService references in src/');

  // 2. No --platform CLI flag
  const platformFlagFiles = srcFiles
    .filter(f => !f.includes('dry-run-preview'))
    .filter(f => {
      const content = fs.readFileSync(f, 'utf-8');
      return /--platform/.test(content);
    });
  assert.equal(
    platformFlagFiles.length,
    0,
    `--platform still used in: ${platformFlagFiles.map(f => path.relative(ROOT, f)).join(', ')}`
  );
  console.log('  ✓ No --platform flag in src/');

  // 3. No platforms.primary config reads
  const platformsPrimaryFiles = srcFiles.filter(f => {
    const content = fs.readFileSync(f, 'utf-8');
    return /platforms\.primary/.test(content);
  });
  assert.equal(
    platformsPrimaryFiles.length,
    0,
    `platforms.primary still referenced in: ${platformsPrimaryFiles.map(f => path.relative(ROOT, f)).join(', ')}`
  );
  console.log('  ✓ No platforms.primary config reads in src/');

  // 4. Old directory gone
  assert.equal(
    fs.existsSync(path.join(SRC, 'integrations', 'platforms')),
    false,
    'src/integrations/platforms/ still exists'
  );
  console.log('  ✓ src/integrations/platforms/ removed');

  // 5. New directory exists with renamed files
  const issueTrackersDir = path.join(SRC, 'integrations', 'issue-trackers');
  assert.equal(fs.existsSync(issueTrackersDir), true, 'issue-trackers/ missing');
  const expectedFiles = [
    'issue-tracker-adapter.interface.ts',
    'issue-tracker-config.service.ts',
    'issue-tracker.module.ts',
    'issue-tracker.service.ts',
  ];
  for (const file of expectedFiles) {
    assert.equal(fs.existsSync(path.join(issueTrackersDir, file)), true, `Missing: ${file}`);
  }
  console.log('  ✓ src/integrations/issue-trackers/ contains renamed files');

  // 6. DTO exports IssueTrackerTicketReference
  const dtoContent = fs.readFileSync(path.join(SRC, 'common', 'dto', 'universal-ticket.dto.ts'), 'utf-8');
  assert.ok(/IssueTrackerTicketReference/.test(dtoContent), 'DTO missing IssueTrackerTicketReference');
  assert.ok(/tracker: string/.test(dtoContent), 'DTO missing tracker field on IssueTrackerTicketReference');
  assert.ok(/trackerData/.test(dtoContent), 'DTO missing trackerData field on UniversalTicket');
  console.log('  ✓ DTO exports IssueTrackerTicketReference with tracker field');

  // 7. NormalizedWfConfig has tracker key
  const configLoaderContent = fs.readFileSync(path.join(SRC, 'config', 'wf-config-loader.ts'), 'utf-8');
  assert.ok(
    /tracker: 'jira' \| 'github' \| 'bitbucket'/.test(configLoaderContent),
    'NormalizedWfConfig missing tracker key'
  );
  console.log('  ✓ NormalizedWfConfig has tracker key');

  // 8. Help catalog uses --tracker not --platform
  const catalog = getCommandHelpCatalog(path.join(SRC, 'commands'));
  const trackerCommands = [
    'issue',
    'issue:fetch',
    'issue:plan',
    'issue:implement',
    'issue:commit',
    'issue:create',
    'issue:pr',
    'issue:generate',
  ];
  for (const cmd of trackerCommands) {
    const entry = catalog[cmd];
    assert.ok(entry, `Command ${cmd} missing from catalog`);
    const hasTracker = entry.options?.some(o => o.flags.includes('--tracker'));
    assert.ok(hasTracker, `${cmd} missing --tracker option`);
    const hasPlatform = entry.options?.some(o => o.flags.includes('--platform'));
    assert.equal(hasPlatform, false, `${cmd} still has --platform option`);
  }
  console.log('  ✓ Help catalog shows --tracker for all tracker-aware commands');

  console.log('\n✅ All migration smoke tests passed');
};

run();
