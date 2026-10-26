/**
 * Manual smoke test: skill-gate.sh check-stop blocks Codex turns that edited code without loading
 * both team skills; `load` prints the sentinels that unlock the session
 *
 * Run: nr test:manual skill-gate-codex-stop-gate.smoke
 *
 * Verifies:
 *   1. a transcript with only message items passes silently
 *   2. a transcript with an apply_patch tool call and no sentinels blocks, citing skill-gate.sh load
 *   3. "apply_patch" appearing only in assistant prose does not trigger the gate
 *   4. WF_MANAGED_SESSION=1 passes silently even on a blocking transcript
 *   5. load exits 0 and prints both WF_SKILL_LOADED sentinels plus recognizable skill content
 *   6. one sentinel in the transcript still blocks; both sentinels unlock
 *   7. a missing or absent transcript_path passes silently
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';
import { isSilentPass, runGate, stopInput } from './support/skill-gate-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const messageLine = (text: string): string =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text }] } });

const applyPatchLine = JSON.stringify({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' },
});

const sentinelLine = (skill: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', output: `WF_SKILL_LOADED: ${skill}` },
  });

const blockReason = (stdout: string): string | undefined => {
  try {
    const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
    return parsed.decision === 'block' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
};

const appendLine = (transcript: string, line: string): void => fs.appendFileSync(transcript, `${line}\n`);

const checkMessageOnlyTranscript = (transcript: string): void => {
  console.log(chalk.bold('Test 1: message-only transcript passes'));
  appendLine(transcript, messageLine('hi'));
  const result = runGate('check-stop', { input: stopInput(transcript) });
  assert('no edits passes silently', isSilentPass(result), result.stdout + result.stderr);
};

const checkProseMentionDoesNotTrigger = (workDir: string): void => {
  console.log(chalk.bold('\nTest 2: apply_patch in prose does not trigger'));
  const proseTranscript = path.join(workDir, 'prose.jsonl');
  appendLine(proseTranscript, messageLine('we could use apply_patch here'));
  const result = runGate('check-stop', { input: stopInput(proseTranscript) });
  assert('prose mention passes silently', isSilentPass(result), result.stdout + result.stderr);
};

const checkEditsWithoutSkillsBlock = (transcript: string): void => {
  console.log(chalk.bold('\nTest 3: edits without skills block'));
  appendLine(transcript, applyPatchLine);
  const result = runGate('check-stop', { input: stopInput(transcript) });
  const reason = blockReason(result.stdout);
  assert('apply_patch without sentinels blocks', reason !== undefined, result.stdout + result.stderr);
  assert('block reason cites skill-gate.sh load', (reason ?? '').includes('skill-gate.sh load'), reason);
};

const checkHeadlessBypass = (transcript: string): void => {
  console.log(chalk.bold('\nTest 4: headless bypass'));
  const result = runGate('check-stop', { input: stopInput(transcript), env: { WF_MANAGED_SESSION: '1' } });
  assert('WF_MANAGED_SESSION=1 passes silently', isSilentPass(result), result.stdout + result.stderr);
};

const checkLoadPrintsSentinelsAndContent = (): void => {
  console.log(chalk.bold('\nTest 5: load prints sentinels and skill content'));
  const result = runGate('load');
  assert('load exits 0', result.status === 0, result.stderr);
  assert('prints coding-style sentinel', result.stdout.includes('WF_SKILL_LOADED: coding-style'));
  assert(
    'prints test-driven-development sentinel',
    result.stdout.includes('WF_SKILL_LOADED: test-driven-development'),
  );
  assert('prints coding-style frontmatter', result.stdout.includes('name: coding-style'));
  assert('prints test-driven-development content', result.stdout.includes('The iron law'));
};

const checkSentinelsUnlock = (transcript: string): void => {
  console.log(chalk.bold('\nTest 6: sentinels unlock the session'));
  appendLine(transcript, sentinelLine('coding-style'));
  const partial = runGate('check-stop', { input: stopInput(transcript) });
  assert('one sentinel still blocks', blockReason(partial.stdout) !== undefined, partial.stdout + partial.stderr);
  appendLine(transcript, sentinelLine('test-driven-development'));
  const unlocked = runGate('check-stop', { input: stopInput(transcript) });
  assert('both sentinels pass silently', isSilentPass(unlocked), unlocked.stdout + unlocked.stderr);
};

const checkMissingTranscriptPasses = (workDir: string): void => {
  console.log(chalk.bold('\nTest 7: missing transcript passes'));
  const absentPath = runGate('check-stop', { input: stopInput(path.join(workDir, 'nope.jsonl')) });
  assert('nonexistent transcript_path passes silently', isSilentPass(absentPath), absentPath.stdout + absentPath.stderr);
  const absentField = runGate('check-stop', { input: stopInput() });
  assert('absent transcript_path passes silently', isSilentPass(absentField), absentField.stdout + absentField.stderr);
};

const runChecks = (workDir: string): void => {
  const transcript = path.join(workDir, 'rollout.jsonl');
  checkMessageOnlyTranscript(transcript);
  checkProseMentionDoesNotTrigger(workDir);
  checkEditsWithoutSkillsBlock(transcript);
  checkHeadlessBypass(transcript);
  checkLoadPrintsSentinelsAndContent();
  checkSentinelsUnlock(transcript);
  checkMissingTranscriptPasses(workDir);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  skill-gate Codex stop gate smoke test\n'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skill-gate-'));
  try {
    runChecks(workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main();
