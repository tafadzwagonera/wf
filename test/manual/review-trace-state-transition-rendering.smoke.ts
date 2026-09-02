/**
 * Manual smoke test for state transition diagram rendering fixes.
 *
 * Verifies:
 * 1. │ connectors appear between sibling change entries with before/after
 * 2. captured section uses '   ' (not '│  ') when it is the last section
 *
 * Run:
 *   nr test:manual -- test-review-trace-state-transition-rendering
 */

import { formatReviewStateTransition } from '../../src/integrations/ai/review-trace';

function assertIncludes(lines: string[], needle: string, label: string): void {
  const text = lines.join('\n');
  if (!text.includes(needle)) {
    throw new Error(`${label}\n  Expected to find: ${JSON.stringify(needle)}\n  In output:\n${text}`);
  }
}

function assertNotIncludes(lines: string[], needle: string, label: string): void {
  const text = lines.join('\n');
  if (text.includes(needle)) {
    throw new Error(`${label}\n  Expected NOT to find: ${JSON.stringify(needle)}\n  In output:\n${text}`);
  }
}

async function main(): Promise<void> {
  console.log('🧪 Manual smoke: review-trace state transition rendering fixes\n');

  // ── Bug 1: │ connectors between sibling change entries ──
  console.log('Test 1: sibling change entries show │ connectors');
  const siblingResult = formatReviewStateTransition({
    from: 'idle',
    to: 'active',
    steps: [
      {
        frame: 'Service.process()',
        changes: {
          interceptorOrder: { before: '[a]', after: '[b]' },
          requestLoggingHook: { before: 'off', after: 'on' },
        },
      },
    ],
  });

  const siblingOutput = siblingResult.join('\n');
  console.log(siblingOutput);
  console.log();

  // The first change entry (interceptorOrder) is NOT the last sibling,
  // so its before/after sub-lines must use '│  ' continuation.
  assertIncludes(siblingResult, '│  ├─ before', 'Bug 1: expected │ connector on before line for non-last sibling');
  assertIncludes(siblingResult, '│  └─ after', 'Bug 1: expected │ connector on after line for non-last sibling');

  // The last change entry (requestLoggingHook) should use '   ' continuation.
  // Verify the last entry's sub-lines use spaces, not │.
  const lines = siblingResult;
  const lastEntryIdx = lines.findIndex(l => l.includes('└─ requestLoggingHook'));
  if (lastEntryIdx === -1) {
    throw new Error('Bug 1: could not find └─ requestLoggingHook in output');
  }
  const afterLastEntry = lines.slice(lastEntryIdx + 1, lastEntryIdx + 3);
  for (const subLine of afterLastEntry) {
    if (subLine.includes('│  ├─') || subLine.includes('│  └─')) {
      throw new Error(`Bug 1: last sibling sub-line should NOT have │ connector: ${subLine}`);
    }
  }

  console.log('  ✓ Bug 1 verified: │ connectors between sibling changes\n');

  // ── Bug 2: captured section uses '   ' when last ──
  console.log('Test 2: captured section continuation when last');
  const capturedResult = formatReviewStateTransition({
    from: 'init',
    to: 'ready',
    steps: [
      {
        frame: 'Service.init()',
        captured: { config: 'loaded', env: 'production' },
        // no changes, no children → captured is the last section
      },
    ],
  });

  const capturedOutput = capturedResult.join('\n');
  console.log(capturedOutput);
  console.log();

  // captured should use └─ (last section) and its children should NOT
  // be prefixed with │  from the captured section continuation.
  assertIncludes(capturedResult, '└─ captured', 'Bug 2: captured should be the last section (└─)');

  // After '└─ captured', the key-value lines should use '   ' not '│  '
  const capturedIdx = capturedResult.findIndex(l => l.includes('└─ captured'));
  const capturedChildren = capturedResult.slice(capturedIdx + 1);
  for (const child of capturedChildren) {
    // The continuation after └─ captured should never have │  at the
    // same indent level as the captured branch.
    const capturedLineIndent = capturedResult[capturedIdx].indexOf('└─');
    const continuationSlice = child.substring(capturedLineIndent, capturedLineIndent + 3);
    if (continuationSlice === '│  ') {
      throw new Error(`Bug 2: captured children should use '   ' continuation, not '│  ': ${child}`);
    }
  }

  // Also verify captured with changes present uses ├─ and │  continuation
  console.log('Test 2b: captured section continuation when NOT last');
  const capturedWithChanges = formatReviewStateTransition({
    from: 'init',
    to: 'ready',
    steps: [
      {
        frame: 'Service.init()',
        captured: { config: 'loaded' },
        changes: { state: { after: 'ready' } },
      },
    ],
  });

  const capturedWithChangesOutput = capturedWithChanges.join('\n');
  console.log(capturedWithChangesOutput);
  console.log();

  assertIncludes(capturedWithChanges, '├─ captured', 'Bug 2b: captured should NOT be last when changes follow (├─)');

  // The captured children should now use │  continuation
  const capIdx2 = capturedWithChanges.findIndex(l => l.includes('├─ captured'));
  const capChildren2 = capturedWithChanges.slice(capIdx2 + 1);
  const firstChild = capChildren2[0];
  if (firstChild) {
    const capIndent = capturedWithChanges[capIdx2].indexOf('├─');
    const contSlice = firstChild.substring(capIndent, capIndent + 3);
    if (contSlice !== '│  ') {
      throw new Error(`Bug 2b: captured children should use '│  ' when not last, got '${contSlice}': ${firstChild}`);
    }
  }

  console.log('  ✓ Bug 2 verified: captured continuation matches section position\n');

  console.log('✓ Manual smoke test passed: review-trace state transition rendering');
}

main().catch(error => {
  console.error(`✗ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
