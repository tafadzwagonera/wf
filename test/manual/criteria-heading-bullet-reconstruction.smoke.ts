/**
 * Manual smoke test: criteria markdown parsing reconstructs headed, unfragmented bullets
 *
 * Run: nr test:manual -- criteria-heading-bullet-reconstruction.smoke
 *
 * Scenario: The user supplies a `--criteria` markdown file written in the
 * common style of `## Section` headers followed by bullets that wrap across
 * multiple physical lines (as real-world criteria files do). The parser must
 * prefix each guideline with its nearest heading and rejoin wrapped
 * continuation lines into the same guideline, instead of dropping headers and
 * emitting each wrapped line as its own fragment.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The live review prompt contains the single, fully-reconstructed
 *      guideline string with the "Design fidelity: " prefix and both wrapped
 *      lines joined onto the first line.
 *   2. The prompt does not contain the orphan continuation fragment as its own
 *      standalone line (proves continuation lines were rejoined, not
 *      fragmented).
 *   3. The prompt contains the "Accessibility: " prefixed guideline (proves
 *      the second heading resets the section prefix instead of leaking
 *      "Design fidelity" onto it).
 *   4. The prompt does not contain a bare "## Design fidelity" or
 *      "## Accessibility" heading line (proves headers are consumed as
 *      context, not passed through verbatim).
 *   5. The command exits 0.
 *
 * Wire up: build the project first, create a temp git repo with a real diff,
 * write wf.config.js for Claude CLI review, and place a fake `claude`
 * executable ahead of PATH that logs captured stdin to disk and returns a
 * valid CodeReview JSON result. Write the criteria markdown file to a temp
 * path and run the compiled CLI via node dist/main.js rather than calling
 * parseCriteriaMarkdown directly — this test exists to catch dist/src drift
 * and prompt-assembly wiring that a unit test on the parser alone cannot.
 * Teardown: remove the temp repo, fake bin directory, isolated WF_HOME, and
 * prompt logs; restore environment variables.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const validReviewJson = JSON.stringify({
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
});

const CRITERIA_MARKDOWN = [
  '## Design fidelity',
  '',
  '- Compare the implementation against the Figma frame visually, not token-by-token: correct',
  '  colour tokens can still land in the wrong order, direction, or angle. Check colours,',
  '  gradients/stripe direction, spacing, and typography scale against the frame.',
  '- Check the mobile frames separately.',
  '',
  '## Accessibility',
  '',
  '- Chase browser console accessibility warnings to resolution.',
  '',
].join('\n');

const RECONSTRUCTED_GUIDELINE
  = 'Design fidelity: Compare the implementation against the Figma frame visually, not token-by-token: correct '
    + 'colour tokens can still land in the wrong order, direction, or angle. Check colours, gradients/stripe direction, '
    + 'spacing, and typography scale against the frame.';
const ORPHAN_FRAGMENT = 'colour tokens can still land in the wrong order, direction, or angle. Check colours,';
const ACCESSIBILITY_GUIDELINE = 'Accessibility: Chase browser console accessibility warnings to resolution.';

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptsLogPath)}, input + '\\n---\\n');

  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-heading-1',
  }));
});
`;

async function main(): Promise<void> {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
  } else {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-heading-'));
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const promptsLogPath = path.join(tempRoot, 'invocations.prompts.log');
  const trackedFilePath = path.join(repoDir, 'src.ts');
  const criteriaPath = path.join(tempRoot, 'criteria.md');

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });

    fs.writeFileSync(criteriaPath, CRITERIA_MARKDOWN, 'utf-8');

    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
    fs.writeFileSync(trackedFilePath, 'line 1\nline 2\n', 'utf-8');
    execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
    fs.writeFileSync(trackedFilePath, 'line 1\nline 2\nline 3 added\n', 'utf-8');

    fs.writeFileSync(
      configPath,
      [
        'module.exports = {',
        '  ai: [',
        "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    writeExecutable(claudeScriptPath, buildFakeClaudeScript(invocationLogPath, promptsLogPath));

    const env = {
      ...process.env,
      HOME: os.homedir(),
      WF_HOME: wfHomeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const result = spawnSync(
      'node',
      [distMainPath, 'issue:review', '-r', repoDir, '--criteria', criteriaPath, '-s'],
      { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
    ) as SpawnResult;
    const output = `${result.stdout}\n${result.stderr}`;

    const prompts = fs.existsSync(promptsLogPath)
      ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
      : [];
    const firstPrompt = prompts[0] ?? '';

    if (result.status === 0) {
      pass('command exits 0');
    } else {
      fail('command should exit 0', output);
    }

    if (firstPrompt.includes(RECONSTRUCTED_GUIDELINE)) {
      pass('review prompt contains the fully-reconstructed, section-prefixed guideline');
    } else {
      fail('review prompt should contain the fully-reconstructed guideline', firstPrompt.slice(0, 800));
    }

    const promptLines = firstPrompt.split('\n').map(line => line.replace(/^\d+\.\s+/, '').trim());
    const noOrphanFragmentLine = promptLines.every(line => line !== ORPHAN_FRAGMENT);

    if (noOrphanFragmentLine) {
      pass('review prompt does not contain the continuation line as an orphan fragment');
    } else {
      fail('review prompt should not contain the continuation line as its own fragment', firstPrompt.slice(0, 800));
    }

    if (firstPrompt.includes(ACCESSIBILITY_GUIDELINE)) {
      pass('review prompt contains the second section\'s correctly-prefixed guideline');
    } else {
      fail('review prompt should contain the Accessibility-prefixed guideline', firstPrompt.slice(0, 800));
    }

    const noBareHeadingLine = firstPrompt.split('\n').every(line => line.trim() !== '## Design fidelity' && line.trim() !== '## Accessibility');

    if (noBareHeadingLine) {
      pass('review prompt does not contain a bare markdown heading line');
    } else {
      fail('review prompt should not contain a bare markdown heading line', firstPrompt.slice(0, 800));
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
