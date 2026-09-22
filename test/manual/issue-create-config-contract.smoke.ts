import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const ARTIFACT = [
  '# Configuration contract smoke test',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  'Verify create-stage configuration validation.',
].join('\n');

const runIssueCreate = (cwd: string, artifactPath: string): { status: number | null; output: string } => {
  const result = spawnSync(
    process.execPath,
    [DIST_MAIN, 'issue:create', artifactPath, '--tracker', 'jira', '--ticket-project', 'TEST', '--dry-run'],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const writeConfig = (projectDir: string, createConfig: Record<string, unknown>): void => {
  fs.writeFileSync(
    path.join(projectDir, 'wf.config.js'),
    `module.exports = { stages: { create: ${JSON.stringify(createConfig)} } };\n`,
  );
};

const validateDistExists = (): void => {
  if (!fs.existsSync(DIST_MAIN)) {
    throw new Error(
      'dist/main.js must exist before running this smoke test. Run `yarn build` first.',
    );
  }
};

const setupTestEnvironment = (): { projectDir: string; artifactPath: string } => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-issue-create-config-'));
  const artifactPath = path.join(projectDir, 'ticket.md');
  fs.writeFileSync(artifactPath, ARTIFACT);
  return { projectDir, artifactPath };
};

const testValidConfig = (projectDir: string, artifactPath: string): void => {
  writeConfig(projectDir, { verificationConditions: { policyFile: 'verification.policy.json' } });
  const validResult = runIssueCreate(projectDir, artifactPath);
  assert.strictEqual(validResult.status, 0, `valid create config failed:\n${validResult.output}`);
  assert.ok(
    validResult.output.toLowerCase().includes('dry run'),
    `valid config did not reach dry-run output:\n${validResult.output}`,
  );
};

const checkUnsupportedConfig = (projectDir: string, artifactPath: string, key: string, value: unknown): void => {
  writeConfig(projectDir, { [key]: value });
  const invalidResult = runIssueCreate(projectDir, artifactPath);
  assert.notStrictEqual(invalidResult.status, 0, `${key} unexpectedly succeeded:\n${invalidResult.output}`);
  assert.ok(
    invalidResult.output.includes('stages.create'),
    `${key} error omitted create stage:\n${invalidResult.output}`,
  );
  assert.ok(invalidResult.output.includes(key), `${key} error omitted the unsupported key:\n${invalidResult.output}`);
  assert.strictEqual(
    invalidResult.output.toLowerCase().includes('dry run'),
    false,
    `${key} reached dry-run output:\n${invalidResult.output}`,
  );
};

const testUnsupportedConfigs = (projectDir: string, artifactPath: string): void => {
  const unsupportedConfigs: Array<[string, unknown]> = [
    ['provider', 'openai'],
    ['model', 'gpt-5.4'],
    ['backend', 'agent'],
    ['skills', ['writing-plans']],
  ];
  for (const [key, value] of unsupportedConfigs) {
    checkUnsupportedConfig(projectDir, artifactPath, key, value);
  }
};

function main(): void {
  validateDistExists();
  const { projectDir, artifactPath } = setupTestEnvironment();
  try {
    testValidConfig(projectDir, artifactPath);
    testUnsupportedConfigs(projectDir, artifactPath);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

main();
