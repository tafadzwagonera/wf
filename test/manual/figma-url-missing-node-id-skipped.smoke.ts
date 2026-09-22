/**
 * Manual smoke test: FigmaRestClient skips Figma URLs that have no node-id query param
 *
 * Verifies that `fetchFrames` returns `[]` for a URL without `?node-id=` and emits
 * a WARN to the console. Also confirms mixed-batch sequencing: the no-node-id URL is
 * guarded out before any HTTP request while the node-id URL is attempted.
 *
 * Run: nr test:manual figma-url-missing-node-id-skipped.smoke.ts
 */

import chalk from 'chalk';
import { FigmaRestClient } from '../../src/integrations/figma/figma-rest.client';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const URL_WITHOUT_NODE_ID = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed';
const URL_WITH_NODE_ID = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1';
const SENTINEL_TOKEN = 'smoke-test-sentinel-token';

function buildClient(token: string): FigmaRestClient {
  const stubConfig = { get: (key: string) => (key === 'figma.token' ? token : undefined) } as any;
  return new FigmaRestClient(stubConfig);
}

function checkCondition(condition: boolean, passMsg: string, failMsg: string, snippet?: string): void {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg, snippet);
  }
}

function makeCapturingWriter(captured: string[], orig: (...args: any[]) => boolean) {
  return (chunk: string | Buffer, ...rest: any[]) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return orig(chunk, ...rest);
  };
}

function captureConsoleOutput() {
  const captured: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = makeCapturingWriter(captured, origStdout);
  (process.stderr as any).write = makeCapturingWriter(captured, origStderr);
  const restore = () => {
    (process.stdout as any).write = origStdout;
    (process.stderr as any).write = origStderr;
  };
  return { captured, restore };
}

async function runTest1WarnEmittedToConsole(): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: WARN containing ValidationError message emitted to console'));
  (global as any).fetch = async () => {
    throw new Error('fetch must not be called');
  };
  const { captured, restore } = captureConsoleOutput();
  const client = buildClient(SENTINEL_TOKEN);
  await client.fetchFrames([URL_WITHOUT_NODE_ID]);
  restore();
  const output = captured.join('');
  const hasWarn = /Missing node-id query param in Figma URL/i.test(output);
  checkCondition(hasWarn, 'WARN emitted for missing node-id', 'WARN not found', output.slice(0, 300));
}

async function runTest2MixedBatchGuard(): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: mixed batch — URL without node-id skipped, URL with node-id attempted'));
  const attempted: string[] = [];
  (global as any).fetch = async (url: string) => {
    attempted.push(String(url));
    throw new Error('sentinel: fetch reached');
  };
  const client = buildClient(SENTINEL_TOKEN);
  const result = await client.fetchFrames([URL_WITHOUT_NODE_ID, URL_WITH_NODE_ID]);
  const withNodeIdAttempted = attempted.some(u => u.includes('node-id') || u.includes('1-1'));
  const withoutNodeIdAttempted = attempted.some(u => u.includes('Stories-Feed') && !u.includes('node-id'));
  checkCondition(result.length === 0, 'mixed batch returns []', 'expected []', JSON.stringify(result));
  checkCondition(withNodeIdAttempted, 'node-id URL attempted', 'node-id URL skipped', JSON.stringify(attempted));
  checkCondition(!withoutNodeIdAttempted, 'no-node-id skipped', 'no-node-id attempted', JSON.stringify(attempted));
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaRestClient skips URLs missing ?node-id=\n');
  const origFetch = global.fetch;
  try {
    await runTest1WarnEmittedToConsole();
    await runTest2MixedBatchGuard();
  } finally {
    global.fetch = origFetch;
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaRestClient skips URLs without node-id');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
