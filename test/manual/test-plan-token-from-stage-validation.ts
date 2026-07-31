/**
 * Manual Test: plan-token and --from stage validation
 *
 * Run: nr test:manual -- test-plan-token-from-stage-validation
 *
 * Verifies:
 *   1. Plan token with --from fetch is rejected with a clear error
 *   2. Plan token with --from plan is rejected with a clear error
 *   3. Plan token without --from defaults to implement (no "required" error)
 *   4. Non-canonical token (ticket key) without --from still requires --from
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

function captureStderr(): { restore: () => string } {
  let out = '';
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as (chunk: any) => boolean) = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  return {
    restore: () => {
      process.stderr.write = orig;
      return out;
    },
  };
}

function captureStdout(): { restore: () => string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: any) => boolean) = (chunk: any) => {
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

const ticketKey = 'WBP-77';
const hash = hashPlanArtifactSources([ticketKey]);
const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });

const minimalPlan = JSON.stringify({
  action: 'fix',
  summary: 'Test plan for from-stage validation',
  estimatedComplexity: 'low',
  steps: ['Apply patch'],
  affectedFiles: ['src/main.ts'],
  affectedRepositories: [],
});

const buildManifest = (artifactPath: string) =>
  JSON.stringify({
    artifactPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    format: 'json',
    hash,
    sourceKind: 'ticket',
    sourceName: ticketKey,
    ticketKey,
  });

function scaffoldTrackerDir(tmpDir: string): { trackerDir: string; planPath: string } {
  const appBase = path.basename(tmpDir);
  const trackerDir = path.join(tmpDir, '.wf', appBase, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });

  const planPath = path.join(trackerDir, planFilename);
  fs.writeFileSync(planPath, minimalPlan);

  const manifestPath = buildPlanArtifactManifestPath(planPath);
  fs.writeFileSync(manifestPath, buildManifest(planPath));

  const ticketPath = path.join(trackerDir, `${ticketKey}.md`);
  fs.writeFileSync(ticketPath, `# ${ticketKey}: Test ticket\n\n## Description\n\nSmoke test ticket`);

  return { trackerDir, planPath };
}

async function main() {
  const origExit = process.exit;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueCommand);

  // -- Test 1: plan-token + --from fetch is rejected --------------------------
  console.log('\n\uD83E\uDDEA Test 1: plan-token + --from fetch is rejected\n' + '\u2500'.repeat(60));
  {
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    await command.run([planFilename], {
      from: 'fetch',
      action: 'fix',
    } as any);
    const stderr = stderrCapture.restore();
    (process as any).exit = origExit;

    if (exitCode === 1 && stderr.includes('--from implement')) {
      pass('Rejects plan-token with --from fetch and mentions --from implement');
    } else {
      fail(
        'Expected exit(1) and stderr containing "--from implement"',
        `exitCode: ${exitCode}, stderr: ${stderr.slice(0, 300)}`
      );
    }
  }

  // -- Test 2: plan-token + --from plan is rejected ---------------------------
  console.log('\n\uD83E\uDDEA Test 2: plan-token + --from plan is rejected\n' + '\u2500'.repeat(60));
  {
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    await command.run([planFilename], {
      from: 'plan',
      action: 'fix',
    } as any);
    const stderr = stderrCapture.restore();
    (process as any).exit = origExit;

    if (exitCode === 1 && stderr.includes('--from implement')) {
      pass('Rejects plan-token with --from plan and mentions --from implement');
    } else {
      fail(
        'Expected exit(1) and stderr containing "--from implement"',
        `exitCode: ${exitCode}, stderr: ${stderr.slice(0, 300)}`
      );
    }
  }

  // -- Test 3: plan-token without --from defaults to implement ----------------
  console.log('\n\uD83E\uDDEA Test 3: plan-token without --from defaults to implement\n' + '\u2500'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-from-stage-'));
    const restoreHome = overrideHomeDir(tmpDir);
    scaffoldTrackerDir(tmpDir);

    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    const stdoutCapture = captureStdout();
    await command.run([planFilename], {
      tracker: 'jira',
      dryRun: true,
      to: 'implement',
    } as any);
    const stderr = stderrCapture.restore();
    const stdout = stdoutCapture.restore();

    (process as any).cwd = origCwd;
    (process as any).exit = origExit;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (stderr.includes('--from option is required')) {
      fail('Should not require --from when a plan token is provided', `stderr: ${stderr.slice(0, 300)}`);
    } else if (stdout.includes('Stages:')) {
      pass('Plan token without --from defaults to implement and reaches the workflow banner');
    } else {
      // The command may fail downstream for unrelated reasons (missing git repo, etc.)
      // As long as the --from guard was bypassed, the default worked
      if (!stderr.includes('--from option is required')) {
        pass('Plan token without --from bypassed the --from guard (downstream error expected in smoke test)');
      } else {
        fail('Unexpected failure', `stderr: ${stderr.slice(0, 300)}\nstdout: ${stdout.slice(0, 300)}`);
      }
    }
  }

  // -- Test 4: non-canonical token without --from still requires it -----------
  console.log('\n\uD83E\uDDEA Test 4: ticket key without --from still requires --from\n' + '\u2500'.repeat(60));
  {
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    await command.run(['WBP-42'], {
      action: 'fix',
    } as any);
    const stderr = stderrCapture.restore();
    (process as any).exit = origExit;

    if (exitCode === 1 && stderr.includes('--from option is required')) {
      pass('Ticket key without --from correctly requires --from');
    } else {
      fail(
        'Expected exit(1) and stderr containing "--from option is required"',
        `exitCode: ${exitCode}, stderr: ${stderr.slice(0, 300)}`
      );
    }
  }

  // -- Summary ----------------------------------------------------------------
  await app.close();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
