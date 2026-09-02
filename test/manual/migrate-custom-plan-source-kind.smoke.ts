/**
 * Manual Test: migration script corrects mis-stamped custom plan manifests
 *
 * Run: nr test:manual -- test-migrate-custom-plan-source-kind
 *
 * Verifies:
 *   1. Mis-stamped custom manifests (sourceKind 'ticket') are corrected to 'custom'
 *   2. Already-correct custom manifests are left untouched
 *   3. Legitimate ticket manifests under tracker dirs (jira/) are not modified
 *   4. Dry-run mode reports what would change without writing
 *   5. A second live run after correction reports all manifests as already correct
 */

import { runMigration } from '../../scripts/migrate-custom-plan-source-kind';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const buildManifest = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    artifactPath: '/tmp/placeholder.json',
    action: 'fix',
    createdAt: new Date().toISOString(),
    format: 'json',
    hash: 'abcd1234',
    sourceKind: 'ticket',
    sourceName: 'placeholder',
    ...overrides,
  }, null, 2);

function main(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-migrate-'));
  const repoDir = path.join(rootDir, 'my-repo');
  const trackerDir = path.join(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });

  const ticketManifestPath = path.join(trackerDir, 'WBP-123-fix-plan.sources.json');
  const ticketArtifactPath = path.join(trackerDir, 'WBP-123-fix-plan.json');
  fs.writeFileSync(ticketArtifactPath, '{}');
  fs.writeFileSync(
    ticketManifestPath,
    buildManifest({
      artifactPath: ticketArtifactPath,
      sourceKind: 'ticket',
      sourceName: 'WBP-123',
      ticketKey: 'WBP-123',
    })
  );

  const misstampedManifestPath = path.join(repoDir, 'my-custom-plan-fix-plan.sources.json');
  const misstampedArtifactPath = path.join(repoDir, 'my-custom-plan-fix-plan.json');
  fs.writeFileSync(misstampedArtifactPath, '{}');
  fs.writeFileSync(
    misstampedManifestPath,
    buildManifest({
      artifactPath: misstampedArtifactPath,
      sourceKind: 'ticket',
      sourceName: 'my-custom-plan',
      ticketKey: 'my-custom-plan',
    })
  );

  const correctManifestPath = path.join(repoDir, 'other-plan-fix-plan.sources.json');
  const correctArtifactPath = path.join(repoDir, 'other-plan-fix-plan.json');
  fs.writeFileSync(correctArtifactPath, '{}');
  fs.writeFileSync(
    correctManifestPath,
    buildManifest({
      artifactPath: correctArtifactPath,
      sourceKind: 'custom',
      sourceName: 'other-plan',
      customArtifactName: 'other-plan',
    })
  );

  try {
    console.log(
      '\n\uD83E\uDDEA Test 1: live migration run\n' + '\u2500'.repeat(60)
    );

    const liveResult = runMigration({ rootDir });

    if (liveResult.updatedCount === 1) {
      pass(`updatedCount is 1 (only the mis-stamped manifest)`);
    } else {
      fail(`updatedCount should be 1`, `got: ${liveResult.updatedCount}`);
    }

    if (liveResult.alreadyCorrectCount === 1) {
      pass(`alreadyCorrectCount is 1 (the already-correct custom manifest)`);
    } else {
      fail(`alreadyCorrectCount should be 1`, `got: ${liveResult.alreadyCorrectCount}`);
    }

    if (liveResult.skippedCount === 0) {
      pass(`skippedCount is 0 (no unreadable or unexpected manifests)`);
    } else {
      fail(`skippedCount should be 0`, `got: ${liveResult.skippedCount}`);
    }

    if (liveResult.failedCount === 0) {
      pass(`failedCount is 0`);
    } else {
      fail(`failedCount should be 0`, `got: ${liveResult.failedCount}`);
    }

    console.log(
      '\n\uD83E\uDDEA Test 2: corrected manifest contents\n' + '\u2500'.repeat(60)
    );

    const correctedRaw = JSON.parse(fs.readFileSync(misstampedManifestPath, 'utf-8'));

    if (correctedRaw.sourceKind === 'custom') {
      pass('Corrected manifest has sourceKind: "custom"');
    } else {
      fail('Corrected manifest sourceKind mismatch', `got: ${correctedRaw.sourceKind}`);
    }

    if (correctedRaw.customArtifactName === 'my-custom-plan') {
      pass('Corrected manifest has customArtifactName: "my-custom-plan"');
    } else {
      fail('Corrected manifest customArtifactName mismatch', `got: ${correctedRaw.customArtifactName}`);
    }

    if (correctedRaw.ticketKey === undefined) {
      pass('Corrected manifest has no ticketKey');
    } else {
      fail('Corrected manifest should not have ticketKey', `got: ${correctedRaw.ticketKey}`);
    }

    console.log(
      '\n\uD83E\uDDEA Test 3: ticket manifest under jira/ untouched\n' + '\u2500'.repeat(60)
    );

    const ticketRaw = JSON.parse(fs.readFileSync(ticketManifestPath, 'utf-8'));

    if (ticketRaw.sourceKind === 'ticket') {
      pass('Ticket manifest sourceKind is still "ticket"');
    } else {
      fail('Ticket manifest sourceKind was incorrectly changed', `got: ${ticketRaw.sourceKind}`);
    }

    if (ticketRaw.ticketKey === 'WBP-123') {
      pass('Ticket manifest ticketKey is still "WBP-123"');
    } else {
      fail('Ticket manifest ticketKey was incorrectly changed', `got: ${ticketRaw.ticketKey}`);
    }

    console.log(
      '\n\uD83E\uDDEA Test 4: dry-run mode\n' + '\u2500'.repeat(60)
    );

    fs.writeFileSync(
      misstampedManifestPath,
      buildManifest({
        artifactPath: misstampedArtifactPath,
        sourceKind: 'ticket',
        sourceName: 'my-custom-plan',
        ticketKey: 'my-custom-plan',
      })
    );

    const dryResult = runMigration({ rootDir, dryRun: true });

    if (dryResult.updatedCount === 1) {
      pass('Dry-run reports updatedCount 1 (would update)');
    } else {
      fail('Dry-run updatedCount should be 1', `got: ${dryResult.updatedCount}`);
    }

    const afterDryRun = JSON.parse(fs.readFileSync(misstampedManifestPath, 'utf-8'));
    if (afterDryRun.sourceKind === 'ticket') {
      pass('Dry-run did not modify the file on disk');
    } else {
      fail('Dry-run should not have written to disk', `sourceKind is now: ${afterDryRun.sourceKind}`);
    }

    console.log(
      '\n\uD83E\uDDEA Test 5: idempotent second run\n' + '\u2500'.repeat(60)
    );

    runMigration({ rootDir });
    const secondRun = runMigration({ rootDir });

    if (secondRun.updatedCount === 0) {
      pass('Second run updatedCount is 0 (nothing left to correct)');
    } else {
      fail('Second run should find nothing to update', `got: ${secondRun.updatedCount}`);
    }

    if (secondRun.alreadyCorrectCount === 2) {
      pass('Second run alreadyCorrectCount is 2 (both custom manifests correct)');
    } else {
      fail('Second run alreadyCorrectCount should be 2', `got: ${secondRun.alreadyCorrectCount}`);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${counts.passed} passed   \u274C ${counts.failed} failed`);
  if (counts.failed === 0) console.log('\u2705 All tests passed!');
  console.log('\u2501'.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main();
