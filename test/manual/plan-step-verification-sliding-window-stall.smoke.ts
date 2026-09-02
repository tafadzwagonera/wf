import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';

let passed = 0;
let failed = 0;

const pass = (msg: string) => {
  console.log(chalk.green(`  PASS  ${msg}`));
  passed++;
};

const fail = (msg: string, detail?: string) => {
  const suffix = detail ? '\n    → ' + detail : '';
  console.error(chalk.red('  FAIL  ' + msg + suffix));
  failed++;
};

const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function todaysLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getWfLogDir(), `agent-${date}.log`);
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-stall-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v2\n');
  return dir;
}

async function main(): Promise<void> {
  console.log('Manual smoke: fidelity sliding window terminates when refreshSteps returns null\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const originalExecute = aiService.execute.bind(aiService);

  const repoDir = makeRepo();
  const logPath = todaysLogPath();

  // Assertions 1–4: refreshSteps returns null on the first call — loop exits without
  // running an assessment round, so no fix round is triggered
  let refreshCallsA = 0;
  let fixCallsA = 0;
  const logSizeA = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const outcomeA = await service.run({
    steps: ['Step A'],
    planSummary: 'stall-on-null smoke test',
    repoDir,
    sessionId: 'sess-stall',
    stallWindow: 2,
    silent: true,
    runFixRound: async () => { fixCallsA++; return { sessionId: 'sess-stall' }; },
    refreshSteps: async () => { refreshCallsA++; return null; },
  });

  const logA = fs.readFileSync(logPath, 'utf-8').slice(logSizeA);

  if (refreshCallsA === 1) {
    pass('refreshSteps called exactly once before the loop exited on null');
  } else {
    fail('Expected refreshSteps to be called exactly once', 'actual: ' + refreshCallsA);
  }

  if (logA.includes('step-verify.fidelity.stalled round=1')) {
    pass('step-verify.fidelity.stalled round=1 logged at WARN');
  } else {
    fail('Expected step-verify.fidelity.stalled round=1 in the log', logA.slice(0, 500));
  }

  if (outcomeA.summary === undefined) {
    pass('outcome.summary is undefined — graceful stall, not a scored outcome');
  } else {
    fail('Expected outcome.summary to be undefined', JSON.stringify(outcomeA.summary));
  }

  if (fixCallsA === 0) {
    pass('runFixRound was never called — stall fired before assessment');
  } else {
    fail('Expected runFixRound to not be called', 'called ' + fixCallsA + ' time(s)');
  }

  // Assertion 5: non-null on rounds 1 and 2, null on round 3 — proves the loop
  // continued past round 2 (did not stall early on a non-null return)
  (aiService as any).execute = async () => ({
    content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
  });

  let refreshCallsB = 0;
  const logSizeB = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  await service.run({
    steps: ['Step A'],
    planSummary: 'non-null on round 2 does not stall',
    repoDir,
    sessionId: 'sess-continue',
    stallWindow: 3,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-continue' }),
    refreshSteps: async () => {
      refreshCallsB++;
      if (refreshCallsB >= 3) return null;
      return ['Step A variant ' + refreshCallsB];
    },
  });

  const logB = fs.readFileSync(logPath, 'utf-8').slice(logSizeB);

  if (refreshCallsB >= 3 && logB.includes('step-verify.fidelity.stalled round=3')) {
    pass('Non-null on rounds 1 and 2 did not stall — loop reached round 3 before stalling');
  } else {
    fail(
      'Expected loop to reach round 3 before stalling',
      'refreshCallsB=' + refreshCallsB + ' log=' + logB.slice(0, 300),
    );
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: fidelity sliding window stall');
}

main().catch(error => {
  console.error('\nManual smoke test failed: ' + error.message);
  process.exit(1);
});
