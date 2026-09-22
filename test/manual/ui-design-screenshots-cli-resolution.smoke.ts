/**
 * Manual smoke test: --ui-design-screenshots CLI scan and explicit modes resolve through live planning
 *
 * Run: nr test:manual ui-design-screenshots-cli-resolution.smoke.ts
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

type TempDirs = {
  tempRoot: string;
  wfHomeDir: string;
  repoDir: string;
  binDir: string;
  configPath: string;
  claudeScriptPath: string;
  repoBasename: string;
  trackerDir: string;
};

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

function initGitRepo(repoDir: string): void {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(path.join(repoDir, 'src.ts'), 'export const x = 1;\n', 'utf-8');
  execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
}

function writeWfConfig(configPath: string): void {
  const content = [
    'module.exports = {',
    '  ai: [',
    "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
    '  ],',
    '  stages: {',
    "    plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
    '  },',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, content, 'utf-8');
}

function writeTrackerFixtures(trackerDir: string): void {
  fs.writeFileSync(path.join(trackerDir, 'WBP-777.md'), '# WBP-777: Fix broken layout\n\nDetails here.\n', 'utf-8');
  fs.writeFileSync(path.join(trackerDir, 'WBP-778.md'), '# WBP-778: Fix another layout\n\nDetails here.\n', 'utf-8');
  fs.writeFileSync(path.join(trackerDir, 'WBP-779.md'), '# WBP-779: Unrelated fix\n\nDetails here.\n', 'utf-8');
}

function buildEnvVars(wfHomeDir: string, binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: os.homedir(),
    WF_HOME: wfHomeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
}

function setupEnvironment(
  repoDir: string,
  trackerDir: string,
  wfHomeDir: string,
  configPath: string,
  claudeScriptPath: string,
): NodeJS.ProcessEnv {
  initGitRepo(repoDir);
  writeWfConfig(configPath);
  writeExecutable(claudeScriptPath, buildFakeClaudeScript());
  writeTrackerFixtures(trackerDir);
  return buildEnvVars(wfHomeDir, path.dirname(claudeScriptPath));
}

function validateScanPlanArtifact(trackerDir: string): void {
  const scanPlanPath = findPlanArtifact(trackerDir);
  const scanPlan = scanPlanPath ? JSON.parse(fs.readFileSync(scanPlanPath, 'utf-8')) : undefined;
  const scanShots: string[] = scanPlan?.uiDesignScreenshots ?? [];
  const hasHero = scanShots.some(p => p.includes(path.join('WBP-777', 'hero.png')));
  const hasBanner = scanShots.some(p => p.includes(path.join('WBP-777', 'banner.jpg')));
  if (hasHero && hasBanner) {
    pass('plan artifact records scanned screenshots under $WF_HOME/<repo>/WBP-777/');
  } else {
    fail('plan artifact should record scanned screenshots under $WF_HOME/<repo>/WBP-777/', JSON.stringify(scanPlan));
  }
}

function setupScanDir(wfHomeDir: string, repoBasename: string): void {
  const scanDir = path.join(wfHomeDir, repoBasename, 'WBP-777');
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'hero.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(scanDir, 'banner.jpg'), Buffer.from([0xff, 0xd8]));
}

function checkScanResult(scanResult: SpawnResult): void {
  if (scanResult.status === 0) {
    pass('bare --ui-design-screenshots run exits 0');
  } else {
    const scanOutput = `${scanResult.stdout}\n${scanResult.stderr}`;
    fail('bare --ui-design-screenshots run should exit 0', scanOutput);
  }
}

function buildScanArgs(repoDir: string): string[] {
  return ['-k', 'WBP-777', '--action', 'fix', '-r', repoDir, '--ui-design-screenshots'];
}

function testScanMode(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  wfHomeDir: string,
  repoBasename: string,
  trackerDir: string,
): void {
  setupScanDir(wfHomeDir, repoBasename);
  const scanResult = runPlan(repoDir, env, buildScanArgs(repoDir));
  checkScanResult(scanResult);
  validateScanPlanArtifact(trackerDir);
}

function resetTrackerDir(trackerDir: string): void {
  fs.rmSync(trackerDir, { recursive: true, force: true });
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, 'WBP-778.md'), '# WBP-778: Fix another layout\n\nDetails here.\n', 'utf-8');
  fs.writeFileSync(path.join(trackerDir, 'WBP-779.md'), '# WBP-779: Unrelated fix\n\nDetails here.\n', 'utf-8');
}

function validateExplicitPlanArtifact(trackerDir: string, repoDir: string): void {
  const planPath = findPlanArtifact(trackerDir);
  const plan = planPath ? JSON.parse(fs.readFileSync(planPath, 'utf-8')) : undefined;
  const shots: string[] = plan?.uiDesignScreenshots ?? [];
  const expectedHero = path.join(repoDir, 'hero.png');
  const expectedCard = path.join(repoDir, 'card.webp');
  if (shots.includes(expectedHero) && shots.includes(expectedCard)) {
    pass('plan artifact records both explicit paths resolved under the repo working tree');
  } else {
    fail('plan artifact should record both explicit paths under the repo working tree', JSON.stringify(plan));
  }
}

function validateNoTicketScanDir(wfHomeDir: string, repoBasename: string): void {
  const ticketScanDir = path.join(wfHomeDir, repoBasename, 'WBP-778');
  if (!fs.existsSync(ticketScanDir)) {
    pass('explicit-path run does not look under $WF_HOME/<repo>/WBP-778/ for the named files');
  } else {
    fail('explicit-path run should not create/use $WF_HOME/<repo>/WBP-778/', fs.readdirSync(ticketScanDir).join(', '));
  }
}

function setupExplicitFiles(repoDir: string): void {
  fs.writeFileSync(path.join(repoDir, 'hero.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(repoDir, 'card.webp'), Buffer.alloc(4));
}

function checkExplicitResult(result: SpawnResult): void {
  if (result.status === 0) {
    pass('explicit-files run exits 0');
  } else {
    const output = `${result.stdout}\n${result.stderr}`;
    fail('explicit-files run should exit 0', output);
  }
}

function buildExplicitArgs(repoDir: string): string[] {
  return ['-k', 'WBP-778', '--action', 'fix', '-r', repoDir, '--ui-design-screenshots', 'hero.png', 'card.webp'];
}

function testExplicitFiles(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  wfHomeDir: string,
  repoBasename: string,
  trackerDir: string,
): void {
  resetTrackerDir(trackerDir);
  setupExplicitFiles(repoDir);
  const result = runPlan(repoDir, env, buildExplicitArgs(repoDir));
  checkExplicitResult(result);
  validateExplicitPlanArtifact(trackerDir, repoDir);
  validateNoTicketScanDir(wfHomeDir, repoBasename);
}

function verifyNoFlagStatus(noFlagResult: SpawnResult, noFlagOutput: string): void {
  if (noFlagResult.status === 0) {
    pass('flag-absent run exits 0');
  } else {
    fail('flag-absent run should exit 0', noFlagOutput);
  }
}

function verifyNoFlagLog(agentLog: string, noFlagOutput: string): void {
  if (!agentLog.includes('scan directory not found') && !noFlagOutput.includes('scan directory not found')) {
    pass('no missing scan-directory WARN when the flag is absent');
  } else {
    fail('flag-absent run should not log a missing scan-directory WARN', agentLog.slice(0, 500));
  }
}

function testNoFlag(repoDir: string, env: NodeJS.ProcessEnv, wfHomeDir: string): void {
  const noFlagResult = runPlan(repoDir, env, ['-k', 'WBP-779', '--action', 'fix', '-r', repoDir]);
  const noFlagOutput = `${noFlagResult.stdout}\n${noFlagResult.stderr}`;
  const agentLog = readAgentLog(wfHomeDir);
  verifyNoFlagStatus(noFlagResult, noFlagOutput);
  verifyNoFlagLog(agentLog, noFlagOutput);
}

function initializeDirs(repoDir: string, binDir: string, wfHomeDir: string, trackerDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });
}

function checkDistExists(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function buildDirPaths(repoDir: string, binDir: string, wfHomeDir: string): Omit<TempDirs, 'tempRoot' | 'wfHomeDir' | 'repoDir' | 'binDir'> {
  const repoBasename = path.basename(repoDir);
  return {
    configPath: path.join(repoDir, 'wf.config.js'),
    claudeScriptPath: path.join(binDir, 'claude'),
    repoBasename,
    trackerDir: path.join(wfHomeDir, repoBasename, 'jira'),
  };
}

function createTempDirs(): TempDirs {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ui-design-screenshots-'));
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const paths = buildDirPaths(repoDir, binDir, wfHomeDir);
  return { tempRoot, wfHomeDir, repoDir, binDir, ...paths };
}

async function runTests(dirs: any, env: NodeJS.ProcessEnv): Promise<void> {
  testScanMode(dirs.repoDir, env, dirs.wfHomeDir, dirs.repoBasename, dirs.trackerDir);
  testExplicitFiles(dirs.repoDir, env, dirs.wfHomeDir, dirs.repoBasename, dirs.trackerDir);
  testNoFlag(dirs.repoDir, env, dirs.wfHomeDir);
}

async function main(): Promise<void> {
  checkDistExists();
  const dirs = createTempDirs();
  try {
    initializeDirs(dirs.repoDir, dirs.binDir, dirs.wfHomeDir, dirs.trackerDir);
    const env = setupEnvironment(dirs.repoDir, dirs.trackerDir, dirs.wfHomeDir, dirs.configPath, dirs.claudeScriptPath);
    await runTests(dirs, env);
  } finally {
    fs.rmSync(dirs.tempRoot, { recursive: true, force: true });
  }
  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
