import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { createReporter } from './reporter';
import {
  cleanupHarness,
  distMainPath,
  setupImplementHarness,
  type ImplementHarness,
  type RunResult,
} from './implement-cli-harness';

export type StubRequest = { url: string; body: Record<string, any> };

export type StubServer = { server: http.Server; baseUrl: string; requests: StubRequest[] };

export type Scenario = {
  harness: ImplementHarness;
  screenshotDir: string;
  screenshots: { hero: string; card: string };
  invocationLog: string;
};

export type Invocation = { cli: 'claude' | 'codex'; argv: string[]; stdin: string };

export const heroBytes = Buffer.from('hero-image-bytes');
export const cardBytes = Buffer.from('card-image-bytes');
export const heroFinding = { area: 'header', deviation: 'button label casing differs' };

export const assertDistExists = (): void => {
  if (fs.existsSync(distMainPath)) return;
  console.error('dist/main.js must exist before running this smoke test. Run `yarn build` first.');
  process.exit(1);
};

const anthropicMessage = (text: string): string => JSON.stringify({
  id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-stub',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const readBody = async (req: http.IncomingMessage): Promise<Record<string, any>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
  } catch {
    return {};
  }
};

const imageDataOf = (body: Record<string, any>): string | undefined => {
  const blocks = (body.messages?.[0]?.content ?? []) as Array<Record<string, any>>;
  return Array.isArray(blocks) ? blocks.find(block => block.type === 'image')?.source?.data : undefined;
};

const respondWithFindings = (res: http.ServerResponse, body: Record<string, any>): void => {
  const isHero = imageDataOf(body) === heroBytes.toString('base64');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(anthropicMessage(JSON.stringify({ findings: isHero ? [heroFinding] : [] })));
};

const boundBaseUrl = (server: http.Server): string => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server failed to bind');
  return `http://127.0.0.1:${address.port}`;
};

export const startStubServer = async (): Promise<StubServer> => {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then(body => {
      requests.push({ url: req.url ?? '', body });
      respondWithFindings(res, body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: boundBaseUrl(server), requests };
};

export const stopStubServer = async (stub: StubServer): Promise<void> => {
  stub.server.close();
  await once(stub.server, 'close');
};

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') { console.log('2.1.219 (Claude Code)'); process.exit(0); }
const { invocationLog, implementCountFile, conformanceCountFile, resolveHeroOnCall, heroFinding } = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const stdin = fs.readFileSync(0, 'utf8');
const fullPrompt = process.argv.slice(2).join('\\n') + '\\n' + stdin;
fs.appendFileSync(invocationLog, JSON.stringify({ cli: 'claude', argv: process.argv.slice(2), stdin }) + '\\n');
const emit = message => console.log(JSON.stringify(message));
const schemaArg = process.argv[process.argv.indexOf('--json-schema') + 1] || '';
if (schemaArg.includes('"steps"') && !schemaArg.includes('"approved"')) {
  const repo = path.basename(process.cwd());
  const plan = {
    action: 'fix', summary: 'Fake plan for design conformance smoke test', steps: ['Edit src/a.ts', 'Verify the change'],
    affectedFiles: [repo + '/src/a.ts'], affectedRepositories: [repo], risks: [],
  };
  emit({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: plan, session_id: 'plan', num_turns: 1 });
} else if (schemaArg.includes('"suggestions"') && schemaArg.includes('"approved"')) {
  const review = { summary: 'Looks good', issues: [], suggestions: [], approved: true };
  emit({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: review, session_id: 'review', num_turns: 1 });
} else if (fullPrompt.includes('You are given one design screenshot')) {
  const isHero = fullPrompt.includes('hero.png');
  if (isHero) fs.appendFileSync(conformanceCountFile, 'x');
  const heroCalls = isHero ? fs.readFileSync(conformanceCountFile, 'utf8').length : 0;
  const resolved = resolveHeroOnCall !== undefined && heroCalls >= resolveHeroOnCall;
  const findings = isHero && !resolved ? [heroFinding] : [];
  emit({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { findings }, session_id: 'dc', num_turns: 1 });
} else {
  fs.appendFileSync(implementCountFile, 'x');
  if (fs.readFileSync(implementCountFile, 'utf8').length === 1) {
    fs.appendFileSync('src/a.ts', '// implemented\\n');
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.resolve('src/a.ts') } }] } });
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', num_turns: 1 });
}
`;

const fakeCodexSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') { console.log('codex-cli 0.150.0'); process.exit(0); }
const { invocationLog, heroFinding } = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(invocationLog, JSON.stringify({ cli: 'codex', argv: process.argv.slice(2), stdin }) + '\\n');
const findings = stdin.includes('hero.png') ? [heroFinding] : [];
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-dc' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings }) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;

const configSource = (implementStage: Record<string, unknown>, extraAi: Array<Record<string, unknown>>): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
  ...extraAi.map(entry => `    ${JSON.stringify(entry)},`),
  '  ],',
  '  stages: {',
  "    plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
  "    review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
  `    implement: ${JSON.stringify({ provider: 'anthropic', backend: 'cli', ...implementStage })},`,
  '  },',
  '};',
  '',
].join('\n');

export const writeImplementConfig = (
  scenario: Scenario, implementStage: Record<string, unknown>, extraAi: Array<Record<string, unknown>> = [],
): void => {
  fs.writeFileSync(path.join(scenario.harness.repoDir, 'wf.config.js'), configSource(implementStage, extraAi));
};

const writeScreenshots = (screenshotDir: string): Scenario['screenshots'] => {
  const screenshots = { hero: path.join(screenshotDir, 'hero.png'), card: path.join(screenshotDir, 'card.png') };
  fs.writeFileSync(screenshots.hero, heroBytes);
  fs.writeFileSync(screenshots.card, cardBytes);
  return screenshots;
};

const addScreenshotsToPlan = (planPath: string, screenshots: Scenario['screenshots']): void => {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  fs.writeFileSync(planPath, JSON.stringify({ ...plan, uiDesignScreenshots: [screenshots.hero, screenshots.card] }));
};

const installFakeClis = (harness: ImplementHarness, resolveHeroOnCall?: number): string => {
  const invocationLog = path.join(harness.tempRoot, 'invocations.log');
  fs.writeFileSync(invocationLog, '');
  fs.writeFileSync(path.join(harness.binDir, 'scenario.json'), JSON.stringify({
    invocationLog, heroFinding, implementCountFile: path.join(harness.tempRoot, 'implement-count.txt'),
    conformanceCountFile: path.join(harness.tempRoot, 'conformance-count.txt'), resolveHeroOnCall,
  }));
  for (const [name, source] of [['claude', fakeClaudeSource], ['codex', fakeCodexSource]] as const) {
    fs.writeFileSync(path.join(harness.binDir, name), source, { mode: 0o755 });
  }
  return invocationLog;
};

export const createScenario = (
  prefix: string, implementStage: Record<string, unknown>, extraAi: Array<Record<string, unknown>> = [],
  resolveHeroOnCall?: number,
): Scenario => {
  const harness = setupImplementHarness(prefix, 'noop', ['src/a.ts']);
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}shots-`));
  const screenshots = writeScreenshots(screenshotDir);
  addScreenshotsToPlan(harness.planPath, screenshots);
  const scenario = { harness, screenshotDir, screenshots, invocationLog: installFakeClis(harness, resolveHeroOnCall) };
  writeImplementConfig(scenario, implementStage, extraAi);
  return scenario;
};

export const setPlanScreenshots = (scenario: Scenario, paths: string[] | undefined): void => {
  const { planPath } = scenario.harness;
  const { uiDesignScreenshots: _removed, ...plan } = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  fs.writeFileSync(planPath, JSON.stringify(paths ? { ...plan, uiDesignScreenshots: paths } : plan));
};

export const resetRepoForRerun = (scenario: Scenario): void => {
  const { harness } = scenario;
  fs.rmSync(path.join(harness.homeDir, '.wf', 'state'), { recursive: true, force: true });
  fs.mkdirSync(path.join(harness.homeDir, '.wf', 'state'), { recursive: true });
  fs.writeFileSync(path.join(harness.repoDir, 'src', 'a.ts'), 'export {};\n');
  fs.rmSync(path.join(harness.tempRoot, 'implement-count.txt'), { force: true });
  fs.rmSync(path.join(harness.tempRoot, 'conformance-count.txt'), { force: true });
  fs.writeFileSync(scenario.invocationLog, '');
};

const buildRunEnv = (harness: ImplementHarness, baseUrl: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: harness.homeDir,
  PATH: `${harness.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  ANTHROPIC_BASE_URL: baseUrl,
  ANTHROPIC_API_KEY: 'test-key',
  WF_SKIP_CLI_VERSION_CHECK: '1',
});

const collectOutput = (child: ReturnType<typeof spawn>): (() => string) => {
  let output = '';
  const append = (chunk: unknown): void => {
    output += String(chunk);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
};

const runCliAsync = (
  scenario: Scenario, baseUrl: string, args: string[], timeoutMs: number,
): Promise<RunResult> => new Promise(resolve => {
  const { harness } = scenario;
  const child = spawn('node', [distMainPath, ...args], { cwd: harness.repoDir, env: buildRunEnv(harness, baseUrl) });
  const output = collectOutput(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('close', code => {
    clearTimeout(timer);
    resolve({ exitCode: code, output: output() });
  });
});

export const runImplementAsync = (scenario: Scenario, baseUrl: string, timeoutMs = 90_000): Promise<RunResult> => {
  const { planPath } = scenario.harness;
  return runCliAsync(scenario, baseUrl, ['issue:implement', planPath, '--silent', '--no-branch', '--skip-install'], timeoutMs);
};

export const ticketKey = 'WBP-901';

export const writeTicketFixture = (scenario: Scenario): void => {
  const { harness } = scenario;
  const trackerDir = path.join(harness.homeDir, '.wf', path.basename(harness.repoDir), 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, `${ticketKey}.md`), `# ${ticketKey}: Align the header with the design\n\nDetails.\n`);
};

export type IssueRunOptions = { from?: string; to?: string; timeoutMs?: number };

export const runIssueAsync = (
  scenario: Scenario, baseUrl: string, extraArgs: string[], options: IssueRunOptions = {},
): Promise<RunResult> => {
  const { from = 'plan', to = 'implement', timeoutMs = 120_000 } = options;
  const args = [
    'issue', '-k', ticketKey, '--action', 'fix', '--from', from, '--to', to, '-t', 'jira', '-r', scenario.harness.repoDir,
    '--silent', '--no-branch', '--skip-install', ...extraArgs,
  ];
  return runCliAsync(scenario, baseUrl, args, timeoutMs);
};

export const readInvocations = (scenario: Scenario): Invocation[] =>
  fs.readFileSync(scenario.invocationLog, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));

export const conformanceInvocations = (scenario: Scenario, cli: 'claude' | 'codex'): Invocation[] =>
  readInvocations(scenario).filter(call => call.cli === cli && call.stdin.includes('You are given one design screenshot'));

export const conformanceCallCount = (scenario: Scenario): number =>
  conformanceInvocations(scenario, 'claude').length + conformanceInvocations(scenario, 'codex').length;

export const argAfter = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

export const readNewestRunFile = (scenario: Scenario): Record<string, any> | undefined => {
  const { harness } = scenario;
  const dir = path.join(harness.homeDir, '.wf', 'state', 'implement-verification', path.basename(harness.repoDir));
  if (!fs.existsSync(dir)) return undefined;
  const [newest] = fs.readdirSync(dir)
    .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return newest ? JSON.parse(fs.readFileSync(path.join(dir, newest.name), 'utf-8')) : undefined;
};

export const cleanupScenario = (scenario: Scenario): void => {
  cleanupHarness(scenario.harness);
  fs.rmSync(scenario.screenshotDir, { recursive: true, force: true });
};

export type SmokeContext = {
  scenario: Scenario;
  stub: StubServer;
  check: (ok: boolean, label: string, detail?: string) => void;
};

export type SmokeOptions = {
  prefix: string;
  stage: Record<string, unknown>;
  extraAi?: Array<Record<string, unknown>>;
  resolveHeroOnCall?: number;
  verify: (context: SmokeContext) => Promise<void>;
};

export const runSmoke = async (options: SmokeOptions): Promise<void> => {
  assertDistExists();
  const { counts, pass, fail } = createReporter();
  const check: SmokeContext['check'] = (ok, label, detail) => (ok ? pass(label) : fail(label, detail));
  const stub = await startStubServer();
  const scenario = createScenario(options.prefix, options.stage, options.extraAi, options.resolveHeroOnCall);
  try {
    await options.verify({ scenario, stub, check });
  } finally {
    await stopStubServer(stub);
    cleanupScenario(scenario);
  }
  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
};
