/**
 * Manual smoke test: commit AI request stays within the diff-excerpt budget
 * even with a hugely lopsided diff, through the real command pipeline
 *
 * Run: nr test:manual -- test-issue-commit-diff-excerpt-budget-live
 *
 * Spins up the real NestJS app context and drives IssueCommitCommand's real
 * `.run()` against a real git repo containing a 1-line change to one file and
 * a ~5000-line change to another, staged together. The two-pass diff-excerpt
 * allocator previously could blow the excerpt hundreds of times past
 * STANDALONE_DIFF_EXCERPT_MAX_CHARS (3000) for exactly this diff shape. Only
 * the outbound AI call (AiService.execute) is stubbed — everything upstream
 * (real git diff, real parseDiffFileStats, real buildPrioritizedDiffExcerpt,
 * real prompt assembly) runs for real, proving the fix holds through the
 * full pipeline rather than just the isolated utility function (covered by
 * commit-diff-stat.spec.ts).
 *
 * Verifies:
 *   1. The actual prompt sent to the AI provider stays close to the
 *      STANDALONE_DIFF_EXCERPT_MAX_CHARS budget, not a multi-hundred-KB blowout
 *   2. The prompt still contains real content from the small file, not just
 *      the big one
 *   3. A real git commit is created reflecting the (stubbed) generated message
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommitCommand } from '../../src/commands/issue-commit.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const STANDALONE_DIFF_EXCERPT_MAX_CHARS = 3000;
const PROMPT_SCAFFOLDING_ALLOWANCE = 1500;

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

async function main(): Promise<void> {
  console.log('\nManual smoke test: commit AI request stays within the diff-excerpt budget for a lopsided diff\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const commitCmd = app.get(IssueCommitCommand);
  const aiService = app.get(AiService);

  const originalExecute = aiService.execute.bind(aiService);
  let capturedPrompt = '';
  aiService.execute = async request => {
    capturedPrompt = request.prompt;
    return {
      content: 'canned commit message from stubbed AI provider',
      provider: 'openai',
      model: 'stub',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-diff-budget-repo-'));

  try {
    const git = (cmd: string): void => {
      execSync(`git ${cmd}`, { cwd: tmpRepo, stdio: 'pipe' });
    };
    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(tmpRepo, 'small.ts'), 'export const small = 1;\n');
    fs.writeFileSync(path.join(tmpRepo, 'big.ts'), 'export const big = 1;\n');
    git('add .');
    git('commit -m init');

    fs.writeFileSync(path.join(tmpRepo, 'small.ts'), 'export const small = 1;\nexport const smallExtra = 2;\n');
    const bigLines = Array.from({ length: 5000 }, (_, i) => `export const value${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tmpRepo, 'big.ts'), `${bigLines}\n`);
    git('add .');

    await commitCmd.run([], { repos: [tmpRepo] });

    assert(
      `prompt sent to the AI provider stays near budget (<= ${STANDALONE_DIFF_EXCERPT_MAX_CHARS + PROMPT_SCAFFOLDING_ALLOWANCE} chars)`,
      capturedPrompt.length <= STANDALONE_DIFF_EXCERPT_MAX_CHARS + PROMPT_SCAFFOLDING_ALLOWANCE,
      `actual prompt length: ${capturedPrompt.length}`
    );
    assert('prompt still contains real content from the small file', capturedPrompt.includes('smallExtra'), capturedPrompt.slice(0, 500));

    const gitLog = execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' });
    assert('a real git commit was created', gitLog.includes('canned commit message from stubbed AI provider'), gitLog);
  } finally {
    aiService.execute = originalExecute;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    await app.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
