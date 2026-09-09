/**
 * Manual smoke test: FigmaStageService logs WARN to disk when all frame fetches fail
 *
 * Verifies that warnIfFramesDegenerate fires and writes to the on-disk agent log
 * when overrideLinks are provided but every frame fetch returns empty. Also checks
 * the negative: when at least one frame succeeds, no WARN is written.
 *
 * Run: nr test:manual -- figma-stage-all-frames-fail-warn.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import { createReporter } from './support/reporter';

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

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService WARN when all frame fetches fail\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-fail-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-'));

  try {
    const fakeLinks = ['https://figma.com/design/abc/Page?node-id=1-2'];

    console.log(chalk.bold.cyan('\nTest 1: all frame fetches fail → WARN written to disk'));
    {
      const configService = makeConfigService({ 'logging.level': 'warn' });
      const logger = new LoggerService(configService);

      const fakeFigmaClient = { fetchFrames: async (_: string[]) => [] } as any;
      const fakeGitService = {} as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);

      const sizeBefore = fs.existsSync(todaysLogPath()) ? fs.statSync(todaysLogPath()).size : 0;

      await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });

      const written = fs.readFileSync(todaysLogPath(), 'utf-8').slice(sizeBefore);
      if (/\[WARN\].*all Figma frame fetches failed/i.test(written)) {
        pass('WARN "all Figma frame fetches failed" written to log');
      } else {
        fail('Expected WARN not found in log', written.slice(0, 300));
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: at least one frame succeeds → no WARN written'));
    {
      const configService = makeConfigService({ 'logging.level': 'warn' });
      const logger = new LoggerService(configService);

      const successFrame = { url: fakeLinks[0], screenshotUrl: '', name: 'Frame', width: 100, height: 100 };
      const fakeFigmaClient = { fetchFrames: async (_: string[]) => [successFrame] } as any;
      const fakeGitService = {} as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);

      const sizeBefore = fs.existsSync(todaysLogPath()) ? fs.statSync(todaysLogPath()).size : 0;

      await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });

      const written = fs.readFileSync(todaysLogPath(), 'utf-8').slice(sizeBefore);
      if (/\[WARN\].*all Figma frame fetches failed/i.test(written)) {
        fail('unexpected WARN written for partial-success case', written.slice(0, 300));
      } else {
        pass('no WARN written when at least one frame succeeds');
      }
    }

    console.log(chalk.bold.cyan('\nTest 3: warnIfFramesDegenerate guard — non-empty links but all fail triggers WARN; empty links does not'));
    {
      const configService = makeConfigService({ 'logging.level': 'warn' });
      const logger = new LoggerService(configService);
      const fakeFigmaClient = { fetchFrames: async (_: string[]) => [] } as any;
      const fakeGitService = { getBranchInfo: async () => ({ current: 'main', all: ['main'], detached: false }) } as any;
      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);

      const warnMessages: string[] = [];
      const origWarn = logger.warn.bind(logger);
      (logger as any).warn = (msg: string, ctx?: string) => {
        warnMessages.push(msg);
        origWarn(msg, ctx);
      };

      await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks });
      const warnAfterFull = warnMessages.filter(m => /all Figma frame fetches failed/i.test(m)).length;
      if (warnAfterFull === 1) {
        pass('non-empty overrideLinks with all-fail triggers exactly one degenerate WARN');
      } else {
        fail('expected exactly 1 degenerate WARN for non-empty overrideLinks', String(warnAfterFull));
      }

      warnMessages.length = 0;
      const sizeBefore = fs.existsSync(todaysLogPath()) ? fs.statSync(todaysLogPath()).size : 0;
      await service.resolveIfEnabled({ repoDir, force: true, overrideLinks: fakeLinks, onProgress: () => {} });
      const written = fs.readFileSync(todaysLogPath(), 'utf-8').slice(sizeBefore);
      if (/\[WARN\].*all Figma frame fetches failed/i.test(written)) {
        pass('WARN also routed to onProgress and disk on repeated call');
      } else {
        fail('WARN not found in log on repeated call', written.slice(0, 300));
      }
    }
  } finally {
    process.env.WF_HOME = origWfHome ?? undefined;
    fs.rmSync(wfHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaStageService WARN on total frame-fetch failure');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
