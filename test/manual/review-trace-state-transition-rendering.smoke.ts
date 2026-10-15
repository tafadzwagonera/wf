/**
 * Manual smoke test for state transition diagram rendering fixes.
 *
 * Verifies:
 * 1. │ connectors appear between sibling change entries with before/after
 * 2. captured section uses '   ' (not '│  ') when it is the last section
 *
 * Run:
 *   nr test:manual review-trace-state-transition-rendering.smoke.ts
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

function buildSiblingScenarioInput() {
  return {
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
  };
}

function runSiblingScenario(): string[] {
  console.log('Test 1: sibling change entries show │ connectors');
  const result = formatReviewStateTransition(buildSiblingScenarioInput());
  console.log(result.join('\n'));
  console.log();
  return result;
}

function checkSiblingConnectors(lines: string[]): void {
  assertIncludes(lines, '│  ├─ before', 'Bug 1: expected │ connector on before line for non-last sibling');
  assertIncludes(lines, '│  └─ after', 'Bug 1: expected │ connector on after line for non-last sibling');
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
}

function runCapturedScenario(): string[] {
  console.log('Test 2: captured section continuation when last');
  const result = formatReviewStateTransition({
    from: 'init',
    to: 'ready',
    steps: [{ frame: 'Service.init()', captured: { config: 'loaded', env: 'production' } }],
  });
  console.log(result.join('\n'));
  console.log();
  return result;
}

function checkCapturedWhenLast(lines: string[]): void {
  assertIncludes(lines, '└─ captured', 'Bug 2: captured should be the last section (└─)');
  const capturedIdx = lines.findIndex(l => l.includes('└─ captured'));
  const capturedChildren = lines.slice(capturedIdx + 1);
  for (const child of capturedChildren) {
    const capturedLineIndent = lines[capturedIdx].indexOf('└─');
    const continuationSlice = child.substring(capturedLineIndent, capturedLineIndent + 3);
    if (continuationSlice === '│  ') {
      throw new Error(`Bug 2: captured children should use '   ' continuation, not '│  ': ${child}`);
    }
  }
}

function runCapturedWithChangesScenario(): string[] {
  console.log('Test 2b: captured section continuation when NOT last');
  const result = formatReviewStateTransition({
    from: 'init',
    to: 'ready',
    steps: [{ frame: 'Service.init()', captured: { config: 'loaded' }, changes: { state: { after: 'ready' } } }],
  });
  console.log(result.join('\n'));
  console.log();
  return result;
}

function checkCapturedWhenNotLast(lines: string[]): void {
  assertIncludes(lines, '├─ captured', 'Bug 2b: captured should NOT be last when changes follow (├─)');
  const capIdx2 = lines.findIndex(l => l.includes('├─ captured'));
  const capChildren2 = lines.slice(capIdx2 + 1);
  const firstChild = capChildren2[0];
  if (firstChild) {
    const capIndent = lines[capIdx2].indexOf('├─');
    const contSlice = firstChild.substring(capIndent, capIndent + 3);
    if (contSlice !== '│  ') {
      throw new Error(`Bug 2b: captured children should use '│  ' when not last, got '${contSlice}': ${firstChild}`);
    }
  }
  console.log('  ✓ Bug 2 verified: captured continuation matches section position\n');
}

const entryArrayInput = {
  from: 'init',
  to: 'ready',
  steps: [
    {
      frame: 'Service.init()',
      captured: [{ name: 'config', value: 'loaded' }],
      changes: [
        { name: 'a', before: '1', after: '2' },
        { name: 'b', before: '3', after: '4' },
      ],
      children: [{ frame: 'Child.run()', changes: [{ name: 'c', after: '5' }] }],
    },
  ],
};

function runEntryArrayScenario(): string[] {
  console.log('Test 3: entry-array captured/changes render connectors');
  const result = formatReviewStateTransition(entryArrayInput);
  console.log(result.join('\n'));
  console.log();
  return result;
}

function checkEntryArrayInput(lines: string[]): void {
  assertIncludes(lines, '├─ captured', 'Entry arrays: captured should precede changes (├─)');
  assertIncludes(lines, '│  ├─ before', 'Entry arrays: expected │ connector between sibling changes');
  assertIncludes(lines, '└─ Child.run()', 'Entry arrays: child frame should nest under parent');
  assertNotIncludes(lines, 'undefined', 'Entry arrays: omitted before must not render as undefined');
  console.log('  ✓ Entry-array input verified\n');
}

async function main(): Promise<void> {
  console.log('🧪 Manual smoke: review-trace state transition rendering fixes\n');
  const siblingResult = runSiblingScenario();
  checkSiblingConnectors(siblingResult);
  const capturedResult = runCapturedScenario();
  checkCapturedWhenLast(capturedResult);
  const capturedWithChanges = runCapturedWithChangesScenario();
  checkCapturedWhenNotLast(capturedWithChanges);
  checkEntryArrayInput(runEntryArrayScenario());
  console.log('✓ Manual smoke test passed: review-trace state transition rendering');
}

main().catch(error => {
  console.error(`✗ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
