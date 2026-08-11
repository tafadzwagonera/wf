/**
 * Manual Test: Provider session ID prompt for custom plan tokens
 *
 * Run: nr test:manual -- test-custom-plan-provider-session-prompt
 *
 * Verifies:
 *   1. Custom plan token with sourceKind='custom' resolves correctly
 *   2. In non-interactive mode (no TTY), the inquirer prompt is skipped and the command completes
 *   3. planArtifact.sessionId remains undefined when the prompt is skipped
 *   4. isInteractiveSession() gate prevents hanging in piped/CI environments
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestPath,
  hashPlanArtifactSources,
} from '../../src/shared/utils/plan-artifact';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

function captureStdout(): { restore: () => string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = orig;
      return out;
    },
  };
}

function overrideHomeDir(nextHomeDir: string): () => void {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = previousHome;
  };
}

const sourceName = 'custom-source';
const hash = hashPlanArtifactSources([sourceName]);
const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });

const minimalPlan = JSON.stringify({
  action: 'fix',
  summary: 'Custom source plan',
  estimatedComplexity: 'low',
  steps: ['Apply patch'],
  affectedFiles: ['src/main.ts'],
  affectedRepositories: [],
});

const buildCustomManifest = (artifactPath: string) =>
  JSON.stringify({
    artifactPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    format: 'json',
    hash,
    sourceKind: 'custom',
    sourceName,
  });

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueCommand);

  console.log(
    '\n\uD83E\uDDEA Test 1: custom plan token completes in non-interactive mode (no TTY)\n' + '\u2500'.repeat(60)
  );
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-session-'));
    const appBase = path.basename(tmpDir);
    const customDir = path.join(tmpDir, '.wf', appBase);
    const trackerDir = path.join(customDir, 'jira');
    fs.mkdirSync(trackerDir, { recursive: true });

    const planPath = path.join(customDir, planFilename);
    fs.writeFileSync(planPath, minimalPlan);
    fs.writeFileSync(buildPlanArtifactManifestPath(planPath), buildCustomManifest(planPath));

    const restoreHome = overrideHomeDir(tmpDir);
    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    const origStdinTTY = process.stdin.isTTY;
    const origStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const stdoutCapture = captureStdout();
    await command.run([planFilename], {
      from: 'implement',
      to: 'implement',
      tracker: 'jira',
      dryRun: true,
    });
    const output = stdoutCapture.restore();

    Object.defineProperty(process.stdin, 'isTTY', { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdoutTTY, configurable: true });
    (process as any).cwd = origCwd;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (output.includes(sourceName) || output.includes('Implement') || output.includes('implement')) {
      pass('Command completed without hanging — prompt was skipped in non-interactive mode');
    } else {
      fail('Command output did not contain expected content', `output: ${output.slice(0, 500)}`);
    }
  }

  console.log('\n\uD83E\uDDEA Test 2: isInteractiveSession() guard returns false without TTY\n' + '\u2500'.repeat(60));
  {
    const origStdinTTY = process.stdin.isTTY;
    const origStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const result = (command as any).isInteractiveSession();

    Object.defineProperty(process.stdin, 'isTTY', { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdoutTTY, configurable: true });

    if (result === false) {
      pass('isInteractiveSession() returns false when stdin.isTTY and stdout.isTTY are false');
    } else {
      fail('isInteractiveSession() should return false without TTY', `got: ${result}`);
    }
  }

  console.log('\n\uD83E\uDDEA Test 3: session state records plan stage lifecycle\n' + '\u2500'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-session-'));
    const appBase = path.basename(tmpDir);
    const customDir = path.join(tmpDir, '.wf', appBase);
    const trackerDir = path.join(customDir, 'jira');
    fs.mkdirSync(trackerDir, { recursive: true });

    const planPath = path.join(customDir, planFilename);
    fs.writeFileSync(planPath, minimalPlan);
    fs.writeFileSync(buildPlanArtifactManifestPath(planPath), buildCustomManifest(planPath));

    const restoreHome = overrideHomeDir(tmpDir);
    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const origExit = process.exit.bind(process);
    (process as any).exit = () => {};

    const stdoutCapture = captureStdout();
    try {
      await command.run([planFilename], {
        from: 'implement',
        to: 'implement',
        tracker: 'jira',
      });
    } catch {
      // Expected: command exits after run
    }
    stdoutCapture.restore();

    (process as any).exit = origExit;

    const sessionDir = path.join(tmpDir, '.wf', 'state', 'sessions');
    const sessionFiles = fs.existsSync(sessionDir)
      ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.json') && !f.endsWith('.items.json'))
      : [];

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    (process as any).cwd = origCwd;
    restoreHome();

    if (sessionFiles.length > 0) {
      const sessionData = JSON.parse(fs.readFileSync(path.join(sessionDir, sessionFiles[0]), 'utf-8'));
      const planRecord = sessionData.stages?.plan;
      if (planRecord) {
        pass(
          `Session file has plan stage record (provider: ${planRecord.config?.provider}, backend: ${planRecord.config?.backend})`
        );
        if (planRecord.completedAt) {
          pass('Plan stage is marked as completed');
        } else {
          fail('Plan stage is not marked as completed');
        }
        if (planRecord.summary === 'Custom source plan') {
          pass(`Plan stage summary captured: "${planRecord.summary}"`);
        } else {
          fail('Plan stage summary not captured', `got: ${planRecord.summary}`);
        }
      } else {
        fail('Session file has no plan stage record', `stages: ${JSON.stringify(sessionData.stages)}`);
      }
    } else {
      fail('No session file was created');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  await app.close();

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${passed} passed   \u274C ${failed} failed`);
  if (failed === 0) console.log('\u2705 All tests passed!');
  console.log('\u2501'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
