/**
 * Manual smoke test: FigmaRestClient skips Figma URLs that have no node-id query param
 *
 * Verifies that `fetchFrames` returns `[]` for a URL without `?node-id=` and issues
 * no HTTP request to the Figma REST API. Previously `parseUrl` returned `nodeId: ''`
 * which produced an `?ids=` REST call that Figma rejects silently. The fix throws
 * `ValidationError` so `attemptFetch` skips the URL and logs a WARN.
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
    console.log(chalk.bold.cyan('\nTest 1: URL without ?node-id= returns [] without calling fetch'));
    {
      let fetchCalled = false;
      (global as any).fetch = async () => {
        fetchCalled = true;
        throw new Error('fetch must not be called for a URL with no node-id');
      };

      const client = buildClient(SENTINEL_TOKEN);
      const result = await client.fetchFrames([URL_WITHOUT_NODE_ID]);

      if (result.length === 0) {
        pass('fetchFrames returns [] for URL without node-id');
      } else {
        fail('expected [], got non-empty result', JSON.stringify(result));
      }

      if (fetchCalled) {
        fail('fetch was called despite the URL having no node-id');
      } else {
        pass('fetch was not called — URL skipped before any HTTP request');
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: WARN containing ValidationError message emitted to console'));
    {
      (global as any).fetch = async () => {
        throw new Error('fetch must not be called');
      };

      const captured: string[] = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      const collect = (chunk: string | Buffer, ...rest: any[]) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      };
      (process.stdout as any).write = (chunk: string | Buffer, ...rest: any[]) => {
        collect(chunk);
        return origStdout(chunk, ...rest);
      };
      (process.stderr as any).write = (chunk: string | Buffer, ...rest: any[]) => {
        collect(chunk);
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

    console.log(chalk.bold.cyan('\nTest 3: URL with ?node-id= does invoke fetch (guard is not over-eager)'));
    {
      let fetchCalled = false;
      (global as any).fetch = async () => {
        fetchCalled = true;
        throw new Error('sentinel: fetch reached');
      };

      const client = buildClient(SENTINEL_TOKEN);
      await client.fetchFrames([URL_WITH_NODE_ID]);

      if (fetchCalled) {
        pass('fetch was called for URL with node-id — guard correctly allows valid URLs through');
      } else {
        fail('fetch was not called for URL with node-id — guard is over-eager');
      }
    }

    console.log(chalk.bold.cyan('\nTest 4: mixed batch — URL without node-id skipped, URL with node-id attempted'));
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
    process.env.FIGMA_TOKEN = origToken ?? undefined;
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaRestClient skips URLs without node-id');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
