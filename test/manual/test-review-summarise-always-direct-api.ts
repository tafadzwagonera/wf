/**
 * Manual Test: review summarise callback always uses direct API
 *
 * Run: nr test:manual -- test-review-summarise-always-direct-api
 *
 * Verifies:
 * 1. The summarise callback in review-stage.service.ts does NOT branch on
 *    stageAgentService.isEnabledForStage — it always uses aiService.execute()
 * 2. The summarise callback does NOT call stageAgentService.generateFromPrompt()
 * 3. The summarise callback calls aiService.execute() with stage: 'review'
 * 4. The stageAgentService import is still present (needed for reviewCode)
 *
 * Context: Spawning a CLI process per file segment during diff summarisation
 * caused issue:review to generate unbounded new sessions for large diffs.
 * The fix removes the CLI branch so summarisation always uses the direct API.
 */

import * as fs from 'fs';
import * as path from 'path';

async function testReviewSummariseAlwaysDirectApi() {
  console.log('\n\u{1F9EA} Manual Test: review summarise callback always uses direct API\n');

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

  const reviewStagePath = path.resolve(__dirname, '../../src/workflows/stages/review-stage.service.ts');
  const source = fs.readFileSync(reviewStagePath, 'utf-8');

  // Extract the summariseCallback body (between its declaration and closing `};`)
  const callbackStart = source.indexOf('const summariseCallback = async');
  const callbackEnd = source.indexOf('};', callbackStart);
  if (callbackStart === -1 || callbackEnd === -1) {
    fail('Could not locate summariseCallback in review-stage.service.ts');
    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }
  const callbackBody = source.slice(callbackStart, callbackEnd + 2);

  // ── Test 1: No isEnabledForStage branch in the callback ────────────────
  {
    if (!callbackBody.includes('isEnabledForStage')) {
      pass('Test 1: summariseCallback does not branch on isEnabledForStage');
    } else {
      fail('Test 1: summariseCallback still contains isEnabledForStage — CLI branch not removed');
    }
  }

  // ── Test 2: No generateFromPrompt call in the callback ─────────────────
  {
    if (!callbackBody.includes('generateFromPrompt')) {
      pass('Test 2: summariseCallback does not call generateFromPrompt');
    } else {
      fail('Test 2: summariseCallback still calls generateFromPrompt — spawns CLI per segment');
    }
  }

  // ── Test 3: Uses aiService.execute with stage: 'review' ────────────────
  {
    const hasExecuteCall = callbackBody.includes('this.aiService.execute(');
    const hasReviewStage = callbackBody.includes("stage: 'review'");
    if (hasExecuteCall && hasReviewStage) {
      pass("Test 3: summariseCallback calls aiService.execute() with stage: 'review'");
    } else {
      fail(`Test 3: Missing direct API call — execute:${hasExecuteCall}, stage:'review':${hasReviewStage}`);
    }
  }

  // ── Test 4: StageAgentService import still present (used by reviewCode) ─
  {
    if (source.includes('import { StageAgentService }')) {
      pass('Test 4: StageAgentService import preserved (needed for reviewCode)');
    } else {
      fail('Test 4: StageAgentService import was removed — reviewCode will break');
    }
  }

  // ── Test 5: reviewCode still uses stageAgentService ─────────────────────
  {
    const reviewCodeStart = source.indexOf('stageAgentService.isEnabledForStage');
    if (reviewCodeStart !== -1 && reviewCodeStart > callbackEnd) {
      pass('Test 5: stageAgentService.isEnabledForStage still used for reviewCode dispatch');
    } else {
      fail('Test 5: stageAgentService.isEnabledForStage not found outside the callback');
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

testReviewSummariseAlwaysDirectApi().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
