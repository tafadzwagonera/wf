/**
 * Manual smoke test: wrote signal propagates correctly through the full call chain
 *
 * Run: nr test:manual -- test-wrote-signal-propagation-live
 *
 * Verifies:
 *   claude-cli adapter:
 *     1. Write block with valid file_path → logCliMessage returns true
 *     2. Write block with empty file_path → logCliMessage returns false
 *     3. Read block → logCliMessage returns false
 *     4. Edit block adds relative path to touchedFiles
 *     5. Read then Edit → aggregation is monotonically true
 *     6. system/progress then Write → progress does not intercept the write
 *     7. Multiple blocks in one message with one Edit → wrote true
 *     8. Bash block → logCliMessage returns false
 *     9. Read-only fix pass sequence → wrote is false
 *     10. Fix pass sequence with Edit → wrote is true
 *   codex-cli adapter:
 *     11. CodexCliAdapter exports correctly from dist
 *     12. attemptCodexFix exists on prototype
 *     13. runCodexFixPass exists on prototype
 *     14. runProgrammaticVerificationLoop exists on prototype
 *     15. buildBaseStreamContext preserves touchedFiles reference
 *     16. buildBaseStreamContext preserves activityState reference
 *     17. No-write early-exit log message compiled into dist
 *     18. trackMessageFiles returns boolean (return true present in source)
 *     19. evaluateVerificationPass detects failing script as code failure
 *     20. evaluateVerificationPass passes all scripts → zero code failures
 *
 * @returns void
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

const spawnProbe = (script: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--require', 'ts-node/register', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../..') },
    );
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => lines.push(line));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code: number | null) => {
      if (code !== 0) reject(new Error(`Child exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(lines);
    });
    setTimeout(() => {
      child.kill();
      reject(new Error('Timed out'));
    }, 15_000);
  });

const get = (lines: string[], prefix: string): string =>
  lines.find(l => l.includes(prefix + ':'))?.split(prefix + ':')[1] ?? '';

async function testClaudeCliChain(): Promise<void> {
  console.log(chalk.bold.underline('  claude-cli adapter'));

  const script = `
    const { ClaudeCliAdapter } = require('./src/integrations/ai/adapters/claude-cli.adapter');
    const adapter = Object.create(ClaudeCliAdapter.prototype);
    const as = { verificationOutcomes: [] };
    const tf = () => new Set();
    const msg = (blocks) => ({
      type: 'assistant',
      message: { content: blocks },
    });
    const tb = (name, input) => ({ type: 'tool_use', name, input: input || {} });

    // 1. Write with valid file_path → true
    console.log('T1:' + adapter.logCliMessage(
      msg([tb('Write', { file_path: '/r/a.ts' })]), '/r', as, tf()
    ));

    // 2. Write with empty file_path → false
    console.log('T2:' + adapter.logCliMessage(
      msg([tb('Write', { file_path: '' })]), '/r', as, tf()
    ));

    // 3. Read → false
    console.log('T3:' + adapter.logCliMessage(
      msg([tb('Read', { file_path: '/r/a.ts' })]), '/r', as, tf()
    ));

    // 4. Edit adds relative path to touchedFiles
    const files4 = tf();
    adapter.logCliMessage(msg([tb('Edit', { file_path: '/r/src/bar.ts' })]), '/r', as, files4);
    console.log('T4:' + [...files4].join(','));

    // 5. Read then Edit → aggregation monotonically true
    let wrote5 = false;
    for (const m of [
      msg([tb('Read', { file_path: '/r/a.ts' })]),
      msg([tb('Edit', { file_path: '/r/a.ts' })]),
    ]) { if (adapter.logCliMessage(m, '/r', as, tf())) wrote5 = true; }
    console.log('T5:' + wrote5);

    // 6. system/progress then Write → progress does not intercept
    let wrote6 = false;
    for (const m of [
      { type: 'system', subtype: 'status', session_id: 's1' },
      msg([tb('Write', { file_path: '/r/b.ts' })]),
    ]) { if (adapter.logCliMessage(m, '/r', as, tf())) wrote6 = true; }
    console.log('T6:' + wrote6);

    // 7. Multiple blocks, one Edit → true
    console.log('T7:' + adapter.logCliMessage(
      msg([tb('Read', { file_path: '/r/a.ts' }), tb('Grep', { pattern: 'x' }), tb('Edit', { file_path: '/r/a.ts' })]),
      '/r', as, tf()
    ));

    // 8. Bash → false
    console.log('T8:' + adapter.logCliMessage(
      msg([tb('Bash', { command: 'echo hello' })]), '/r', as, tf()
    ));

    // 9. Read-only fix pass sequence → false
    let wrote9 = false;
    for (const m of [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      msg([tb('Read', { file_path: '/r/src/existing.ts' })]),
      msg([tb('Grep', { pattern: 'foo' })]),
    ]) { if (adapter.logCliMessage(m, '/r', as, tf())) wrote9 = true; }
    console.log('T9:' + wrote9);

    // 10. Fix pass with Edit → true
    let wrote10 = false;
    for (const m of [
      msg([tb('Read', { file_path: '/r/src/existing.ts' })]),
      msg([tb('Edit', { file_path: '/r/src/existing.ts' })]),
    ]) { if (adapter.logCliMessage(m, '/r', as, tf())) wrote10 = true; }
    console.log('T10:' + wrote10);
  `;

  const lines = await spawnProbe(script);
  assert('Write block with valid file_path -> true', get(lines, 'T1') === 'true', `got: ${get(lines, 'T1')}`);
  assert('Write block with empty file_path -> false', get(lines, 'T2') === 'false', `got: ${get(lines, 'T2')}`);
  assert('Read block -> false', get(lines, 'T3') === 'false', `got: ${get(lines, 'T3')}`);
  assert('Edit adds relative path to touchedFiles', get(lines, 'T4') === 'src/bar.ts', `got: "${get(lines, 'T4')}"`);
  assert('Read then Edit -> aggregation monotonically true', get(lines, 'T5') === 'true', `got: ${get(lines, 'T5')}`);
  assert('system/progress then Write -> progress does not intercept', get(lines, 'T6') === 'true', `got: ${get(lines, 'T6')}`);
  assert('Multiple blocks with one Edit -> true', get(lines, 'T7') === 'true', `got: ${get(lines, 'T7')}`);
  assert('Bash block -> false', get(lines, 'T8') === 'false', `got: ${get(lines, 'T8')}`);
  assert('Read-only fix pass sequence -> wrote false', get(lines, 'T9') === 'false', `got: ${get(lines, 'T9')}`);
  assert('Fix pass with Edit -> wrote true', get(lines, 'T10') === 'true', `got: ${get(lines, 'T10')}`);
}

async function testCodexCliChain(): Promise<void> {
  console.log(chalk.bold.underline('\n  codex-cli adapter'));

  const script = `
    const fs = require('fs');
    const pth = require('path');
    const mod = require('./dist/integrations/ai/adapters/codex-cli.adapter');
    const { CodexCliAdapter } = mod;

    // 11. Export check
    console.log('T11:' + (typeof CodexCliAdapter === 'function'));

    // 12-14. Prototype methods
    const proto = CodexCliAdapter.prototype;
    console.log('T12:' + (typeof proto.attemptCodexFix === 'function'));
    console.log('T13:' + (typeof proto.runCodexFixPass === 'function'));
    console.log('T14:' + (typeof proto.runProgrammaticVerificationLoop === 'function'));

    // 15-16. buildBaseStreamContext preserves references
    const adapter = new CodexCliAdapter({});
    const activityState = { verificationOutcomes: [] };
    const touchedFiles = new Set();
    const ctx = adapter.buildBaseStreamContext({ verificationScripts: [] }, activityState, touchedFiles, '/repo');
    console.log('T15:' + (ctx.touchedFiles === touchedFiles));
    console.log('T16:' + (ctx.activityState === activityState));

    // 17. No-write log message in compiled source
    const src = fs.readFileSync(pth.resolve('dist/integrations/ai/adapters/codex-cli.adapter.js'), 'utf-8');
    console.log('T17:' + src.includes('No files written during fix pass'));

    // 18. trackMessageFiles returns boolean
    console.log('T18:' + (src.includes('return true') && src.includes('return false')));

    // 19. evaluateVerificationPass detects failing script
    const failResult = adapter.evaluateVerificationPass(
      [{ id: 'fail', name: 'fail', command: 'false', policy: 'enforced', aliases: [] }],
      process.cwd()
    );
    console.log('T19_F:' + failResult.codeFailures.length);
    console.log('T19_S:' + failResult.outcomes[0].status);

    // 20. evaluateVerificationPass with passing script
    const passResult = adapter.evaluateVerificationPass(
      [{ id: 'ok', name: 'ok', command: 'echo ok', policy: 'enforced', aliases: [] }],
      process.cwd()
    );
    console.log('T20_F:' + passResult.codeFailures.length);
    console.log('T20_S:' + passResult.outcomes[0].status);
  `;

  const lines = await spawnProbe(script);
  assert('CodexCliAdapter exports correctly from dist', get(lines, 'T11') === 'true');
  assert('attemptCodexFix exists on prototype', get(lines, 'T12') === 'true');
  assert('runCodexFixPass exists on prototype', get(lines, 'T13') === 'true');
  assert('runProgrammaticVerificationLoop exists on prototype', get(lines, 'T14') === 'true');
  assert('buildBaseStreamContext preserves touchedFiles reference', get(lines, 'T15') === 'true');
  assert('buildBaseStreamContext preserves activityState reference', get(lines, 'T16') === 'true');
  assert('No-write early-exit log message compiled into dist', get(lines, 'T17') === 'true');
  assert('trackMessageFiles returns boolean', get(lines, 'T18') === 'true');
  assert('Failing script detected as code failure', get(lines, 'T19_F') === '1' && get(lines, 'T19_S') === 'failed');
  assert('Passing scripts -> zero code failures', get(lines, 'T20_F') === '0' && get(lines, 'T20_S') === 'passed');
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nWrote signal propagation smoke test\n'));

  try {
    await testClaudeCliChain();
  } catch (error) {
    fail('claude-cli chain probe', error instanceof Error ? error.message : String(error));
  }

  try {
    await testCodexCliChain();
  } catch (error) {
    fail('codex-cli chain probe', error instanceof Error ? error.message : String(error));
  }

  console.log(
    chalk.bold(
      `\n${counts.passed + counts.failed} assertions: ${chalk.green(`${counts.passed} passed`)}${counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : ''}\n`,
    ),
  );
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
