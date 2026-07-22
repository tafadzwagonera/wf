/**
 * Manual smoke test: greedy JSON extraction fallback + reviewer agent default onProgress
 *
 * Run: nr test:manual -- test-greedy-json-extraction-and-review-progress
 *
 * Verifies:
 *   1. parseJsonResponse extracts deeply nested JSON with prose preamble via greedy candidate.
 *   2. parseJsonResponse falls through from greedy to conservative when prose after JSON has a stray brace.
 *   3. parseJsonResponse handles clean, code-fenced, and prose+JSON inputs without regression.
 *   4. ReviewerAgent creates a default onProgress callback when none is provided and silent is false.
 *   5. ReviewerAgent uses caller-provided onProgress instead of the default.
 *   6. ReviewerAgent suppresses progress when silent is true.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { parseJsonResponse } from '../../src/integrations/ai/ai.service';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import type { GitService } from '../../src/integrations/git/git.service';
import type { ReviewStageService } from '../../src/workflows/stages/review-stage.service';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

interface ReviewDiffCall {
  diff: string;
  opts: { onProgress?: (line: string) => void };
}

const createTrackingReviewDiff = () => {
  const calls: ReviewDiffCall[] = [];
  const fn = async (diff: string, opts: { onProgress?: (line: string) => void }) => {
    calls.push({ diff, opts });
    opts.onProgress?.('Synthesizing review...');
    return { summary: 'ok', issues: [], suggestions: [], approved: true };
  };
  return { fn, calls };
};

const stubReview = {
  review: { summary: 'ok', issues: [], suggestions: [], approved: true },
  path: '/tmp/.wf/repo/jira/WBP-123-review.md',
  approved: true,
};

const createAgent = (reviewDiffFn: (...args: unknown[]) => unknown): ReviewerAgent => {
  const stubGitService = {
    getStatus: async () => ({ files: ['src/auth.ts'] }),
    stageAll: async () => undefined,
    getDiff: async () => 'diff --git a/file b/file',
  } as unknown as GitService;

  const stubReviewStageService = {
    reviewDiff: reviewDiffFn,
    createReviewArtifact: () => stubReview,
  } as unknown as ReviewStageService;

  const stubConfigService = {
    get: () => undefined,
  } as unknown as ConfigService;

  return new ReviewerAgent(stubGitService, stubReviewStageService, stubConfigService);
};

const ticket = { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' };

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Greedy JSON extraction + review progress smoke test\n'));

  console.log(chalk.bold('Test 1: greedy candidate extracts deeply nested JSON with prose preamble'));
  {
    const response
      = 'Here is my code review:\n'
        + '{"summary": "ok", "issues": [], "traceProvenance": "evidence-based",'
        + ' "callStack": [{"frame": "toPageId(\\"tour\\")", "children": [],'
        + ' "typeInfo": "Record<string, AggregateRating> | {}"}],'
        + ' "stateTransition": {"from": "start", "to": "end", "steps": []},'
        + ' "suggestions": ["Add tests"], "approved": false}';

    const result = parseJsonResponse<{ suggestions: string[]; approved: boolean }>(response);

    assert(
      'suggestions field is present and correct',
      Array.isArray(result.suggestions) && result.suggestions[0] === 'Add tests',
      `got: ${JSON.stringify(result.suggestions)}`
    );
    assert(
      'approved field is present and correct',
      result.approved === false,
      `got: ${String(result.approved)}`
    );
  }

  console.log(chalk.bold('\nTest 2: greedy falls through to conservative when prose after JSON has a stray brace'));
  {
    const response
      = 'Here is my review:\n'
        + '{"summary": "ok", "issues": [], "suggestions": [], "approved": true}'
        + '\n\nSee config}';

    const result = parseJsonResponse<{ summary: string; approved: boolean }>(response);

    assert(
      'summary parsed correctly via conservative fallback',
      result.summary === 'ok',
      `got: ${String(result.summary)}`
    );
    assert(
      'approved parsed correctly via conservative fallback',
      result.approved === true,
      `got: ${String(result.approved)}`
    );
  }

  console.log(chalk.bold('\nTest 3: no regression on clean JSON, code-fenced JSON, and prose+JSON'));
  {
    const clean = '{"key": "value"}';
    const cleanResult = parseJsonResponse<{ key: string }>(clean);
    assert('clean JSON parses', cleanResult.key === 'value', `got: ${String(cleanResult.key)}`);

    const fenced = '```json\n{"key": "fenced"}\n```';
    const fencedResult = parseJsonResponse<{ key: string }>(fenced);
    assert('code-fenced JSON parses', fencedResult.key === 'fenced', `got: ${String(fencedResult.key)}`);

    const prose = 'Sure:\n{"key": "prose"}';
    const proseResult = parseJsonResponse<{ key: string }>(prose);
    assert('prose+JSON parses', proseResult.key === 'prose', `got: ${String(proseResult.key)}`);
  }

  console.log(chalk.bold('\nTest 4: default onProgress callback created when not provided and silent=false'));
  {
    const tracker = createTrackingReviewDiff();
    const agent = createAgent(tracker.fn);

    const originalLog = console.log;
    const logCalls: string[] = [];
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(' '));
    };

    await agent.execute(ticket, { repoDir: '/tmp/repo', silent: false });
    console.log = originalLog;

    const receivedOnProgress = tracker.calls[0]?.opts?.onProgress;
    assert(
      'reviewDiff receives a function for onProgress (default callback)',
      typeof receivedOnProgress === 'function',
      `got: ${typeof receivedOnProgress}`
    );

    const progressLogged = logCalls.some(line => line.includes('Synthesizing review...'));
    assert(
      'default callback logged progress line to console',
      progressLogged,
      'no console.log call found containing "Synthesizing review..."'
    );
  }

  console.log(chalk.bold('\nTest 5: caller-provided onProgress takes precedence'));
  {
    const tracker = createTrackingReviewDiff();
    const agent = createAgent(tracker.fn);

    const callerLines: string[] = [];
    const callerOnProgress = (line: string) => {
      callerLines.push(line);
    };

    const originalLog = console.log;
    console.log = () => undefined;

    await agent.execute(ticket, { repoDir: '/tmp/repo', silent: false, onProgress: callerOnProgress });
    console.log = originalLog;

    assert(
      'caller onProgress received the progress line',
      callerLines.includes('Synthesizing review...'),
      `got: ${JSON.stringify(callerLines)}`
    );

    const receivedOnProgress = tracker.calls[0]?.opts?.onProgress;
    assert(
      'reviewDiff received the caller callback, not a default',
      receivedOnProgress === callerOnProgress,
      'received a different function'
    );
  }

  console.log(chalk.bold('\nTest 6: silent mode suppresses progress'));
  {
    const tracker = createTrackingReviewDiff();
    const agent = createAgent(tracker.fn);

    const originalLog = console.log;
    console.log = () => undefined;

    await agent.execute(ticket, { repoDir: '/tmp/repo', silent: true });
    console.log = originalLog;

    const receivedOnProgress = tracker.calls[0]?.opts?.onProgress;
    assert(
      'reviewDiff receives undefined for onProgress when silent',
      receivedOnProgress === undefined,
      `got: ${typeof receivedOnProgress}`
    );
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
