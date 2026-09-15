/**
 * Manual smoke test: FigmaStageService.resolveIfEnabled emits exactly one WARN per target
 * when called twice with identical options (simulating the pre-fix double-orchestration pattern).
 *
 * Run: nr test:manual -- figma-stage-single-call-per-target.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, def?: T): T | undefined =>
      (key in overrides ? overrides[key] : def) as T | undefined,
  } as any;
}

function makeFakeGitService(branch = 'feat/abc') {
  return {
    getBranchInfo: async () => ({ current: branch, all: [branch, 'main'], isClean: true, hasUncommittedChanges: false }),
  } as any;
}

function warnCount(slice: string): number {
  return (slice.match(/\[WARN\].*no Figma links were captured/g) ?? []).length;
}

async function main(): Promise<void> {
  console.log('Manual smoke: resolveIfEnabled emits exactly one WARN per target on repeated identical calls\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-single-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  try {
    const configService = makeConfigService({ 'stages.review.figma': true, 'logging.level': 'warn' });
    const logger = new LoggerService(configService);
    const fakeGit = makeFakeGitService();
    const fakeFigmaClient = { fetchFrames: async () => [] } as any;
    const service = new FigmaStageService(configService, fakeGit, logger, fakeFigmaClient);

    const logDir = path.join(wfHome, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
    fs.writeFileSync(logFile, '');

    const opts = { repoDir, force: false, onProgress: (msg: string) => { /* captured via log */ } };

    // First call — should emit exactly one WARN.
    await service.resolveIfEnabled(opts);
    const afterFirst = fs.readFileSync(logFile, 'utf-8');
    if (warnCount(afterFirst) === 1) {
      pass('first call: exactly one WARN written to log');
    } else {
      fail('first call: unexpected WARN count', String(warnCount(afterFirst)));
    }

    // Second call with identical options — idempotency guard must suppress additional WARN.
    await service.resolveIfEnabled(opts);
    const afterSecond = fs.readFileSync(logFile, 'utf-8');
    if (warnCount(afterSecond) === 1) {
      pass('second call: no additional WARN written (cache hit)');
    } else {
      fail('second call: WARN count increased — idempotency guard not firing', String(warnCount(afterSecond)));
    }

    // Third call with different repoDir — must produce a new WARN (independent target).
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-other-'));
    try {
      await service.resolveIfEnabled({ ...opts, repoDir: otherRepo });
      const afterThird = fs.readFileSync(logFile, 'utf-8');
      if (warnCount(afterThird) === 2) {
        pass('third call (different repoDir): new WARN emitted — targets are independent');
      } else {
        fail('third call: unexpected WARN count for independent target', String(warnCount(afterThird)));
      }
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(wfHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    process.env.WF_HOME = origWfHome;
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: resolveIfEnabled emits exactly one WARN per target');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
