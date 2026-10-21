/**
 * Manual smoke test: FigmaStageService logs WARN to disk when all frame fetches fail
 *
 * Verifies that warnIfFramesDegenerate fires and writes to the on-disk agent log
 * when overrideLinks are provided but every frame fetch returns empty. Also checks
 * the negative: when at least one frame succeeds, no WARN is written.
 *
 * Run: nr test:manual figma-stage-all-frames-fail-warn.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/common/logger/logger.service';
import { getWfLogDir } from '../../src/common/utils/wf-paths';
import { createReporter } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

function todaysLogPath(): string {
  return path.join(getWfLogDir(), `agent-${new Date().toISOString().slice(0, 10)}.log`);
}

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, def?: T): T | undefined =>
      (key in overrides ? overrides[key] : def) as T | undefined,
  } as any;
}

function checkCondition(condition: boolean, passMsg: string, failMsg: string, snippet?: string): void {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg, snippet);
  }
}

function interceptWarnMessages(logger: LoggerService): string[] {
  const captured: string[] = [];
  const origWarn = logger.warn.bind(logger);
  (logger as any).warn = (msg: string, ctx?: string) => {
    captured.push(msg);
    origWarn(msg, ctx);
  };
  return captured;
}

function setupSmokeEnv() {
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-fail-'));
  withEnv({ WF_HOME: wfHome });
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-'));
  return { wfHome, repoDir };
}

function teardownSmokeEnv(wfHome: string, repoDir: string): void {
  restoreEnv();
  fs.rmSync(wfHome, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
}

async function runTest1AllFramesFail(repoDir: string, fakeLinks: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: all frame fetches fail → WARN written to disk'));
  const configService = makeConfigService({ 'logging.level': 'warn' });
  const logger = new LoggerService(configService);
  const fakeFigmaClient = { fetchFrames: async (_: string[]) => [] } as any;
  const service = new FigmaStageService(configService, {} as any, logger, fakeFigmaClient);
  const sizeBefore = fs.existsSync(todaysLogPath()) ? fs.statSync(todaysLogPath()).size : 0;
  await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });
  const written = fs.readFileSync(todaysLogPath(), 'utf-8').slice(sizeBefore);
  const hasWarn = /\[WARN\].*all Figma frame fetches failed/i.test(written);
  checkCondition(hasWarn, 'WARN "all frames failed" in log', 'Expected WARN not found', written.slice(0, 300));
}

async function runTest2PartialSuccessNoWarn(repoDir: string, fakeLinks: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: at least one frame succeeds → no WARN written'));
  const configService = makeConfigService({ 'logging.level': 'warn' });
  const logger = new LoggerService(configService);
  const successFrame = { url: fakeLinks[0], screenshotUrl: '', name: 'Frame', width: 100, height: 100 };
  const fakeFigmaClient = { fetchFrames: async (_: string[]) => [successFrame] } as any;
  const service = new FigmaStageService(configService, {} as any, logger, fakeFigmaClient);
  const sizeBefore = fs.existsSync(todaysLogPath()) ? fs.statSync(todaysLogPath()).size : 0;
  await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });
  const written = fs.readFileSync(todaysLogPath(), 'utf-8').slice(sizeBefore);
  const hasWarn = /\[WARN\].*all Figma frame fetches failed/i.test(written);
  checkCondition(!hasWarn, 'no WARN for partial success', 'unexpected WARN written', written.slice(0, 300));
}

async function runTest3WarnDegenerateGuard(repoDir: string, fakeLinks: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 3: warnIfFramesDegenerate — all-fail triggers WARN'));
  const configService = makeConfigService({ 'logging.level': 'warn' });
  const logger = new LoggerService(configService);
  const fakeFigmaClient = { fetchFrames: async (_: string[]) => [] } as any;
  const fakeGitService = { getBranchInfo: async () => ({ current: 'main', all: ['main'], detached: false }) } as any;
  const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);
  const warnMessages = interceptWarnMessages(logger);
  await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });
  const count = warnMessages.filter(m => /all Figma frame fetches failed/i.test(m)).length;
  checkCondition(count === 1, 'all-fail triggers exactly one WARN', 'expected exactly 1 WARN', String(count));
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService WARN when all frame fetches fail\n');
  const { wfHome, repoDir } = setupSmokeEnv();
  const fakeLinks = ['https://figma.com/design/abc/Page?node-id=1-2'];
  try {
    await runTest1AllFramesFail(repoDir, fakeLinks);
    await runTest2PartialSuccessNoWarn(repoDir, fakeLinks);
    await runTest3WarnDegenerateGuard(repoDir, fakeLinks);
  } finally {
    teardownSmokeEnv(wfHome, repoDir);
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaStageService WARN on total frame-fetch failure');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
