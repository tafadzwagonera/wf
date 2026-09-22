/**
 * Manual smoke test: FigmaStageService isolates resolution per target in a multi-target review.
 *
 * Each distinct repoDir must produce exactly one WARN; the idempotency guard must not
 * bleed across targets. A duplicate call for the same target must produce no extra WARN.
 *
 * Run: nr test:manual figma-stage-multi-target-isolation.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

type OnProgress = (_msg: string) => void;

type ServiceBundle = {
  service: FigmaStageService;
  logFile: string;
  onProgress: OnProgress;
};

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

function warnCount(text: string): number {
  return (text.match(/\[WARN\].*no Figma links were captured/g) ?? []).length;
}

function setupTempDirs(): { wfHome: string; repoA: string; repoB: string; origWfHome: string | undefined } {
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-multi-'));
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-b-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;
  return { wfHome, repoA, repoB, origWfHome };
}

function cleanupTempDirs(wfHome: string, repoA: string, repoB: string, origWfHome: string | undefined): void {
  fs.rmSync(wfHome, { recursive: true, force: true });
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
  process.env.WF_HOME = origWfHome;
}

function buildServiceBundle(wfHome: string): ServiceBundle {
  const configService = makeConfigService({ 'stages.review.figma': true, 'logging.level': 'warn' });
  const logger = new LoggerService(configService);
  const fakeGit = makeFakeGitService();
  const fakeFigmaClient = { fetchFrames: async () => [] } as any;
  const service = new FigmaStageService(configService, fakeGit, logger, fakeFigmaClient);
  const logDir = path.join(wfHome, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
  fs.writeFileSync(logFile, '');
  const onProgress: OnProgress = _msg => {};
  return { service, logFile, onProgress };
}

async function runFirstTargetA(bundle: ServiceBundle, repoA: string): Promise<void> {
  await bundle.service.resolveIfEnabled({ repoDir: repoA, force: false, onProgress: bundle.onProgress });
  const count = warnCount(fs.readFileSync(bundle.logFile, 'utf-8'));
  if (count === 1) {
    pass('target A: exactly one WARN written');
  } else {
    fail('target A: unexpected WARN count', String(count));
  }
}

async function runFirstTargetB(bundle: ServiceBundle, repoB: string): Promise<void> {
  await bundle.service.resolveIfEnabled({ repoDir: repoB, force: false, onProgress: bundle.onProgress });
  const count = warnCount(fs.readFileSync(bundle.logFile, 'utf-8'));
  if (count === 2) {
    pass('target B: new WARN written — guard does not bleed across distinct targets');
  } else {
    fail('target B: unexpected total WARN count (guard may have bled across targets)', String(count));
  }
}

async function runDuplicateTargetA(bundle: ServiceBundle, repoA: string): Promise<void> {
  await bundle.service.resolveIfEnabled({ repoDir: repoA, force: false, onProgress: bundle.onProgress });
  const count = warnCount(fs.readFileSync(bundle.logFile, 'utf-8'));
  if (count === 2) {
    pass('duplicate call for target A: no additional WARN (cache hit)');
  } else {
    fail('duplicate call for target A: WARN count increased — idempotency guard not firing', String(count));
  }
}

async function runDuplicateTargetB(bundle: ServiceBundle, repoB: string): Promise<void> {
  await bundle.service.resolveIfEnabled({ repoDir: repoB, force: false, onProgress: bundle.onProgress });
  const count = warnCount(fs.readFileSync(bundle.logFile, 'utf-8'));
  if (count === 2) {
    pass('duplicate call for target B: no additional WARN (cache hit)');
  } else {
    fail('duplicate call for target B: WARN count increased', String(count));
  }
}

function reportResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: multi-target isolation holds, guard does not bleed across targets');
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService isolates WARN per target across multi-target review\n');
  const { wfHome, repoA, repoB, origWfHome } = setupTempDirs();
  try {
    const bundle = buildServiceBundle(wfHome);
    await runFirstTargetA(bundle, repoA);
    await runFirstTargetB(bundle, repoB);
    await runDuplicateTargetA(bundle, repoA);
    await runDuplicateTargetB(bundle, repoB);
  } finally {
    cleanupTempDirs(wfHome, repoA, repoB, origWfHome);
  }
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
