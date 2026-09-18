/**
 * Manual smoke test: --ui-design-screenshots CLI scan and explicit modes resolve through live planning
 *
 * Run: nr test:manual -- ui-design-screenshots-cli-resolution.smoke
 *
 * Scenario: The user runs `issue:plan` with `--ui-design-screenshots`. A bare
 * flag must trigger scan mode under `$WF_HOME/<repo>/<ticketKey>/`, while
 * explicit screenshot paths must remain repo-relative and multiple explicit
 * values must be retained.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' }
 *   }
 *
 * Verify:
 *   1. With screenshots placed under $WF_HOME/<repo-basename>/WBP-777/,
 *      running `node dist/main.js issue:plan -k WBP-777 --action fix -r
 *      <repo> --ui-design-screenshots -s` exits 0.
 *   2. The saved plan artifact contains uiDesignScreenshots entries for the
 *      scanned files under $WF_HOME/<repo-basename>/WBP-777/.
 *   3. The command output/logs do not contain a missing scan-directory WARN
 *      when the flag is absent on a separate issue:plan run.
 *   4. With hero.png and card.webp placed in the repo working tree, running
 *      `node dist/main.js issue:plan -k WBP-778 --action fix -r <repo>
 *      --ui-design-screenshots hero.png card.webp -s` exits 0.
 *   5. The saved plan artifact contains both explicit paths, resolved under
 *      the repo working tree.
 *   6. The explicit-path run does not look under
 *      $WF_HOME/<repo>/<ticketKey>/ for those filenames.
 *
 * Wire up: build the project first, create a temp git repo with a
 * wf.config.js for Claude CLI planning, and use a fake `claude` executable
 * that logs stdin and returns a valid ResolutionPlan JSON result. Create
 * ticket artifacts directly under $WF_HOME/<repo-basename>/jira/<ticketKey>.md
 * so the live CLI can load them without hitting a tracker. Run node
 * dist/main.js issue:plan through the compiled CLI for the absent-flag,
 * bare-flag, and explicit-files cases.
 * Teardown: remove the temp repo, fake bin directory, isolated WF_HOME, and
 * invocation logs.
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

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Fake plan for ui-design-screenshots resolution smoke test',
  steps: ['Investigate the reported issue', 'Apply the fix'],
  estimatedComplexity: 'medium',
  affectedRepositories: ['repo'],
});

const buildFakeClaudeScript = (): string => `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(validPlanJson)}, session_id: 'sess-plan-1' }));
});
`;

const runPlan = (repoDir: string, env: NodeJS.ProcessEnv, args: string[]): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:plan', ...args, '-s'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const findPlanArtifact = (trackerDir: string): string | undefined => {
  if (!fs.existsSync(trackerDir)) return undefined;
  const match = fs.readdirSync(trackerDir).find(f => f.endsWith('-plan.json'));
  return match ? path.join(trackerDir, match) : undefined;
};

const readAgentLog = (wfHomeDir: string): string => {
  const logDir = path.join(wfHomeDir, 'logs');
  if (!fs.existsSync(logDir)) return '';
  const logFile = fs.readdirSync(logDir).find(f => f.startsWith('agent-'));
  return logFile ? fs.readFileSync(path.join(logDir, logFile), 'utf-8') : '';
};

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ui-design-screenshots-'));
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const repoBasename = path.basename(repoDir);
  const trackerDir = path.join(wfHomeDir, repoBasename, 'jira');

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(trackerDir, { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });

    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
    fs.writeFileSync(path.join(repoDir, 'src.ts'), 'export const x = 1;\n', 'utf-8');
    execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });

    fs.writeFileSync(
      configPath,
      [
        'module.exports = {',
        '  ai: [',
        "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    writeExecutable(claudeScriptPath, buildFakeClaudeScript());

    fs.writeFileSync(path.join(trackerDir, 'WBP-777.md'), '# WBP-777: Fix broken layout\n\nDetails here.\n', 'utf-8');
    fs.writeFileSync(path.join(trackerDir, 'WBP-778.md'), '# WBP-778: Fix another layout\n\nDetails here.\n', 'utf-8');
    fs.writeFileSync(path.join(trackerDir, 'WBP-779.md'), '# WBP-779: Unrelated fix\n\nDetails here.\n', 'utf-8');

    const env = {
      ...process.env,
      HOME: os.homedir(),
      WF_HOME: wfHomeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const scanDir = path.join(wfHomeDir, repoBasename, 'WBP-777');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'hero.png'), Buffer.from([0x89, 0x50]));
    fs.writeFileSync(path.join(scanDir, 'banner.jpg'), Buffer.from([0xff, 0xd8]));

    const scanResult = runPlan(repoDir, env, ['-k', 'WBP-777', '--action', 'fix', '-r', repoDir, '--ui-design-screenshots']);
    const scanOutput = `${scanResult.stdout}\n${scanResult.stderr}`;

    if (scanResult.status === 0) {
      pass('bare --ui-design-screenshots run exits 0');
    } else {
      fail('bare --ui-design-screenshots run should exit 0', scanOutput);
    }

    const scanPlanPath = findPlanArtifact(trackerDir);
    const scanPlan = scanPlanPath ? JSON.parse(fs.readFileSync(scanPlanPath, 'utf-8')) : undefined;
    const scanShots: string[] = scanPlan?.uiDesignScreenshots ?? [];
    if (scanShots.some(p => p.includes(path.join('WBP-777', 'hero.png'))) && scanShots.some(p => p.includes(path.join('WBP-777', 'banner.jpg')))) {
      pass('plan artifact records scanned screenshots under $WF_HOME/<repo>/WBP-777/');
    } else {
      fail('plan artifact should record scanned screenshots under $WF_HOME/<repo>/WBP-777/', JSON.stringify(scanPlan));
    }
    fs.rmSync(trackerDir, { recursive: true, force: true });
    fs.mkdirSync(trackerDir, { recursive: true });
    fs.writeFileSync(path.join(trackerDir, 'WBP-778.md'), '# WBP-778: Fix another layout\n\nDetails here.\n', 'utf-8');
    fs.writeFileSync(path.join(trackerDir, 'WBP-779.md'), '# WBP-779: Unrelated fix\n\nDetails here.\n', 'utf-8');

    fs.writeFileSync(path.join(repoDir, 'hero.png'), Buffer.from([0x89, 0x50]));
    fs.writeFileSync(path.join(repoDir, 'card.webp'), Buffer.alloc(4));

    const explicitResult = runPlan(
      repoDir, env,
      ['-k', 'WBP-778', '--action', 'fix', '-r', repoDir, '--ui-design-screenshots', 'hero.png', 'card.webp']
    );
    const explicitOutput = `${explicitResult.stdout}\n${explicitResult.stderr}`;

    if (explicitResult.status === 0) {
      pass('explicit-files run exits 0');
    } else {
      fail('explicit-files run should exit 0', explicitOutput);
    }

    const explicitPlanPath = findPlanArtifact(trackerDir);
    const explicitPlan = explicitPlanPath ? JSON.parse(fs.readFileSync(explicitPlanPath, 'utf-8')) : undefined;
    const explicitShots: string[] = explicitPlan?.uiDesignScreenshots ?? [];
    const expectedHero = path.join(repoDir, 'hero.png');
    const expectedCard = path.join(repoDir, 'card.webp');
    if (explicitShots.includes(expectedHero) && explicitShots.includes(expectedCard)) {
      pass('plan artifact records both explicit paths resolved under the repo working tree');
    } else {
      fail('plan artifact should record both explicit paths under the repo working tree', JSON.stringify(explicitPlan));
    }

    const ticketScanDir = path.join(wfHomeDir, repoBasename, 'WBP-778');
    if (!fs.existsSync(ticketScanDir)) {
      pass('explicit-path run does not look under $WF_HOME/<repo>/WBP-778/ for the named files');
    } else {
      fail('explicit-path run should not create/use $WF_HOME/<repo>/WBP-778/', fs.readdirSync(ticketScanDir).join(', '));
    }

    const noFlagResult = runPlan(repoDir, env, ['-k', 'WBP-779', '--action', 'fix', '-r', repoDir]);
    const noFlagOutput = `${noFlagResult.stdout}\n${noFlagResult.stderr}`;
    const agentLog = readAgentLog(wfHomeDir);

    if (noFlagResult.status === 0) {
      pass('flag-absent run exits 0');
    } else {
      fail('flag-absent run should exit 0', noFlagOutput);
    }

    if (!agentLog.includes('scan directory not found') && !noFlagOutput.includes('scan directory not found')) {
      pass('no missing scan-directory WARN when the flag is absent');
    } else {
      fail('flag-absent run should not log a missing scan-directory WARN', agentLog.slice(0, 500));
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
