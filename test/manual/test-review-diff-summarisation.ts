/**
 * Manual Test: review diff summarisation (replaces 5000-char truncation)
 *
 * Run: nr test:manual -- test-review-diff-summarisation
 *
 * Verifies:
 * 1. splitDiffByFile correctly splits a multi-file diff into per-file segments
 * 2. summariseDiff passes through diffs under the threshold unchanged
 * 3. summariseDiff summarises the largest segments first when over threshold
 * 4. summariseDiff preserves original segment order
 * 5. summariseDiff gracefully handles summarisation failures
 * 6. ai.service.ts reviewCode no longer truncates (no substring(0, 5000))
 * 7. stage-agent.service.ts reviewCode no longer truncates
 * 8. review-stage.service.ts integrates summariseDiff before reviewCode
 */

import * as fs from 'fs';
import * as path from 'path';
import { splitDiffByFile, summariseDiff, MAX_REVIEW_DIFF_LENGTH } from '../../src/review/summarise-diff';

async function testReviewDiffSummarisation() {
  console.log('\n\u{1F9EA} Manual Test: review diff summarisation\n');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  \u2713 ${msg}`);
    passed++;
  };

  const fail = (msg: string) => {
    console.log(`  \u2717 ${msg}`);
    failed++;
  };

  // ── Test 1: splitDiffByFile splits multi-file diff ────────────────────
  {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      '-const x = 1;',
      '+const x = 2;',
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -1,2 +1,2 @@',
      '-export const y = "old";',
      '+export const y = "new";',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-# Old',
      '+# New',
    ].join('\n');

    const segments = splitDiffByFile(diff);
    if (
      segments.length === 3
      && segments[0].file === 'src/foo.ts'
      && segments[1].file === 'src/bar.ts'
      && segments[2].file === 'README.md'
    ) {
      pass('Test 1: splitDiffByFile splits 3-file diff correctly');
    } else {
      fail(`Test 1: Expected 3 segments, got ${segments.length}: ${segments.map(s => s.file).join(', ')}`);
    }
  }

  // ── Test 2: summariseDiff passes through under-threshold diffs ────────
  {
    const segments = [{ file: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n-old\n+new' }];
    const mockSummarise = async () => '- summary';
    const result = await summariseDiff(segments, 1000, mockSummarise);

    if (result === segments[0].patch) {
      pass('Test 2: Under-threshold diff passes through unchanged');
    } else {
      fail('Test 2: Under-threshold diff was modified unexpectedly');
    }
  }

  // ── Test 3: summariseDiff summarises largest segments first ────────────
  {
    const smallPatch = 'diff --git a/small.ts b/small.ts\n+x';
    const largePatch = 'diff --git a/large.ts b/large.ts\n' + 'x'.repeat(500);
    let summarisedFile = '';

    const mockSummarise = async (_patch: string, file: string) => {
      summarisedFile = file;
      return `- Changed ${file}`;
    };

    const result = await summariseDiff(
      [
        { file: 'small.ts', patch: smallPatch },
        { file: 'large.ts', patch: largePatch },
      ],
      100,
      mockSummarise
    );

    if (summarisedFile === 'large.ts' && result.includes('(summarised)')) {
      pass('Test 3: Largest segment summarised first');
    } else {
      fail(`Test 3: Expected large.ts to be summarised, got: ${summarisedFile}`);
    }
  }

  // ── Test 4: summariseDiff preserves segment order ─────────────────────
  {
    const mockSummarise = async (_p: string, f: string) => `- ${f}`;
    const result = await summariseDiff(
      [
        { file: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n' + 'a'.repeat(150) },
        { file: 'b.ts', patch: 'diff --git a/b.ts b/b.ts\n+small' },
        { file: 'c.ts', patch: 'diff --git a/c.ts b/c.ts\n' + 'c'.repeat(100) },
      ],
      80,
      mockSummarise
    );

    const aPos = result.indexOf('a.ts');
    const bPos = result.indexOf('b.ts');
    const cPos = result.indexOf('c.ts');

    if (aPos < bPos && bPos < cPos) {
      pass('Test 4: Segment order preserved (a < b < c)');
    } else {
      fail(`Test 4: Order not preserved — a:${aPos}, b:${bPos}, c:${cPos}`);
    }
  }

  // ── Test 5: summariseDiff handles summarisation failures gracefully ───
  {
    const failingPatch = 'diff --git a/fail.ts b/fail.ts\n' + 'f'.repeat(200);
    const okPatch = 'diff --git a/ok.ts b/ok.ts\n+ok';

    const failingSummarise = async (patch: string, _file: string) => {
      if (patch.includes('fail.ts')) throw new Error('AI unavailable');
      return '- Summarised';
    };

    const result = await summariseDiff(
      [
        { file: 'fail.ts', patch: failingPatch },
        { file: 'ok.ts', patch: okPatch },
      ],
      100,
      failingSummarise
    );

    if (result.includes(failingPatch)) {
      pass('Test 5: Failed summarisation keeps raw patch');
    } else {
      fail('Test 5: Failed summarisation did not preserve raw patch');
    }
  }

  // ── Test 6: ai.service.ts no longer truncates ─────────────────────────
  {
    const aiServicePath = path.resolve(__dirname, '../../src/integrations/ai/ai.service.ts');
    const aiServiceSource = fs.readFileSync(aiServicePath, 'utf-8');
    const reviewCodeSection = aiServiceSource.slice(aiServiceSource.indexOf('async reviewCode('));
    const reviewCodeMethod = reviewCodeSection.slice(0, reviewCodeSection.indexOf('\n  async '));

    if (!reviewCodeMethod.includes('substring(0, 5000)')) {
      pass('Test 6: ai.service.ts reviewCode has no 5000-char truncation');
    } else {
      fail('Test 6: ai.service.ts still contains substring(0, 5000)');
    }
  }

  // ── Test 7: stage-agent.service.ts no longer truncates ────────────────
  {
    const stageAgentPath = path.resolve(__dirname, '../../src/integrations/ai/stage-agent.service.ts');
    const stageAgentSource = fs.readFileSync(stageAgentPath, 'utf-8');
    const reviewCodeSection = stageAgentSource.slice(stageAgentSource.indexOf('async reviewCode('));
    const reviewCodeMethod = reviewCodeSection.slice(0, reviewCodeSection.indexOf('\n  async '));

    if (!reviewCodeMethod.includes('substring(0, 5000)')) {
      pass('Test 7: stage-agent.service.ts reviewCode has no 5000-char truncation');
    } else {
      fail('Test 7: stage-agent.service.ts still contains substring(0, 5000)');
    }
  }

  // ── Test 8: review-stage.service.ts integrates summariseDiff ──────────
  {
    const reviewStagePath = path.resolve(__dirname, '../../src/workflows/stages/review-stage.service.ts');
    const reviewStageSource = fs.readFileSync(reviewStagePath, 'utf-8');

    const hasSummariseDiffImport = reviewStageSource.includes('from \'../../review/summarise-diff\'');
    const hasSummariseDiffCall = reviewStageSource.includes('summariseDiff(');
    const hasSplitDiffCall = reviewStageSource.includes('splitDiffByFile(');

    if (hasSummariseDiffImport && hasSummariseDiffCall && hasSplitDiffCall) {
      pass('Test 8: review-stage.service.ts imports and uses summariseDiff');
    } else {
      fail(
        `Test 8: Missing integration — import:${hasSummariseDiffImport}, summariseDiff:${hasSummariseDiffCall}, splitDiffByFile:${hasSplitDiffCall}`
      );
    }
  }

  // ── Test 9: MAX_REVIEW_DIFF_LENGTH is 80,000 ─────────────────────────
  {
    if (MAX_REVIEW_DIFF_LENGTH === 80_000) {
      pass('Test 9: MAX_REVIEW_DIFF_LENGTH is 80,000');
    } else {
      fail(`Test 9: MAX_REVIEW_DIFF_LENGTH is ${MAX_REVIEW_DIFF_LENGTH}, expected 80,000`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

testReviewDiffSummarisation().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
