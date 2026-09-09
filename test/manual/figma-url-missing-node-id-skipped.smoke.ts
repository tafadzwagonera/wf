/**
 * Manual smoke test: FigmaRestClient skips Figma URLs that have no node-id query param
 *
 * Verifies that `fetchFrames` returns `[]` for a URL without `?node-id=` and emits
 * a WARN to the console. Also confirms mixed-batch sequencing: the no-node-id URL is
 * guarded out before any HTTP request while the node-id URL is attempted.
 *
 * Run: nr test:manual -- figma-url-missing-node-id-skipped.smoke
 */

import chalk from 'chalk';
import { FigmaRestClient } from '../../src/integrations/figma/figma-rest.client';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const URL_WITHOUT_NODE_ID = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed';
const URL_WITH_NODE_ID = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1';
const SENTINEL_TOKEN = 'smoke-test-sentinel-token';

function buildClient(token: string): FigmaRestClient {
  process.env.FIGMA_TOKEN = token;
  const stubConfig = { get: () => undefined } as any;
  return new FigmaRestClient(stubConfig);
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaRestClient skips URLs missing ?node-id=\n');

  const origToken = process.env.FIGMA_TOKEN;
  const origFetch = global.fetch;

  try {
    console.log(chalk.bold.cyan('\nTest 1: WARN containing ValidationError message emitted to console'));
    {
      (global as any).fetch = async () => {
        throw new Error('fetch must not be called');
      };

      const captured: string[] = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      (process.stdout as any).write = (chunk: string | Buffer, ...rest: any[]) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return origStdout(chunk, ...rest);
      };
      (process.stderr as any).write = (chunk: string | Buffer, ...rest: any[]) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return origStderr(chunk, ...rest);
      };

      const client = buildClient(SENTINEL_TOKEN);
      await client.fetchFrames([URL_WITHOUT_NODE_ID]);

      (process.stdout as any).write = origStdout;
      (process.stderr as any).write = origStderr;

      const output = captured.join('');
      if (/Missing node-id query param in Figma URL/i.test(output)) {
        pass('WARN with "Missing node-id query param" emitted to console');
      } else {
        fail('expected WARN not found in console output', output.slice(0, 300));
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: mixed batch — URL without node-id skipped, URL with node-id attempted'));
    {
      const attempted: string[] = [];
      (global as any).fetch = async (url: string) => {
        attempted.push(String(url));
        throw new Error('sentinel: fetch reached');
      };

      const client = buildClient(SENTINEL_TOKEN);
      const result = await client.fetchFrames([URL_WITHOUT_NODE_ID, URL_WITH_NODE_ID]);

      const withNodeIdAttempted = attempted.some(u => u.includes('node-id') || u.includes('1-1'));
      const withoutNodeIdAttempted = attempted.some(u => u.includes('Stories-Feed') && !u.includes('node-id'));

      if (result.length === 0) {
        pass('mixed batch returns [] (both URLs end up skipped — one by guard, one by fetch error)');
      } else {
        fail('expected [] from mixed batch', JSON.stringify(result));
      }

      if (withNodeIdAttempted && !withoutNodeIdAttempted) {
        pass('only the URL with node-id reached fetch; the no-node-id URL was guarded out');
      } else {
        fail('fetch call pattern unexpected', JSON.stringify(attempted));
      }
    }
  } finally {
    global.fetch = origFetch;
    if (origToken === undefined) {
      delete process.env.FIGMA_TOKEN;
    } else {
      process.env.FIGMA_TOKEN = origToken;
    }
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaRestClient skips URLs without node-id');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
