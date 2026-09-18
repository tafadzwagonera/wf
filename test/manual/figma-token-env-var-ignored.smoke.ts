/**
 * Manual smoke test: FigmaRestClient ignores FIGMA_TOKEN env var; uses figma.token config only
 *
 * Verifies that setting FIGMA_TOKEN in the environment has no effect after the env-var
 * fallback was removed. Also confirms the config path still passes the token as the
 * X-Figma-Token header.
 *
 * Run: nr test:manual -- figma-token-env-var-ignored.smoke
 */

import chalk from 'chalk';
import { FigmaRestClient } from '../../src/integrations/figma/figma-rest.client';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const URL_WITH_NODE_ID = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1';

function buildClient(configToken: string | undefined): FigmaRestClient {
  const stubConfig = { get: (key: string) => (key === 'figma.token' ? configToken : undefined) } as any;
  return new FigmaRestClient(stubConfig);
}

function captureOutput(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: string | Buffer, ...rest: any[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origStdout(chunk, ...rest);
    };
    (process.stdout as any).write = capture;
    (process.stderr as any).write = (chunk: string | Buffer, ...rest: any[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origStderr(chunk, ...rest);
    };
    fn().then(() => {
      (process.stdout as any).write = origStdout;
      (process.stderr as any).write = origStderr;
      resolve(chunks.join(''));
    }).catch(err => {
      (process.stdout as any).write = origStdout;
      (process.stderr as any).write = origStderr;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaRestClient ignores FIGMA_TOKEN env var; uses figma.token config only\n');

  const origToken = process.env.FIGMA_TOKEN;
  const origFetch = global.fetch;

  try {
    console.log(chalk.bold.cyan('\nTest 1: FIGMA_TOKEN env var set but figma.token absent → returns [], fetch not called'));
    {
      process.env.FIGMA_TOKEN = 'sentinel-env-token';
      const client = buildClient(undefined);
      let fetchCalled = false;
      (global as any).fetch = async () => {
        fetchCalled = true;
        throw new Error('fetch must not be called');
      };

      let result: unknown[] = [];
      const output = await captureOutput(async () => {
        result = await client.fetchFrames([URL_WITH_NODE_ID]);
      });

      if (result.length === 0) {
        pass('returns [] when figma.token is absent from config');
      } else {
        fail('expected [] but got frames', JSON.stringify(result));
      }

      if (!fetchCalled) {
        pass('fetch was not called — env var did not enable frame fetching');
      } else {
        fail('fetch was called unexpectedly — env var fallback may have been reintroduced');
      }

      if (/figma\.token not configured/i.test(output)) {
        pass('WARN "figma.token not configured" emitted');
      } else {
        fail('expected WARN "figma.token not configured" not found in output', output.slice(0, 300));
      }

      if (/FIGMA_TOKEN/i.test(output)) {
        fail('output references FIGMA_TOKEN — old fallback message may have been reintroduced', output.slice(0, 300));
      } else {
        pass('output does not reference FIGMA_TOKEN — env-var fallback cleanly removed');
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: figma.token set in config (FIGMA_TOKEN absent) → fetch called with correct header'));
    {
      delete process.env.FIGMA_TOKEN;
      const client = buildClient('config-tok');
      let capturedHeader: string | undefined;
      (global as any).fetch = async (url: string, init: RequestInit) => {
        capturedHeader = (init.headers as Record<string, string>)?.['X-Figma-Token'];
        return {
          ok: false,
          status: 401,
          json: async () => ({ err: 'Unauthorized' }),
        } as unknown as Response;
      };

      await client.fetchFrames([URL_WITH_NODE_ID]);

      if (capturedHeader === 'config-tok') {
        pass('X-Figma-Token header set from figma.token config value');
      } else {
        fail('X-Figma-Token header wrong or absent', JSON.stringify(capturedHeader));
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
  console.log('\nManual smoke test passed: FigmaRestClient ignores FIGMA_TOKEN env var');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
