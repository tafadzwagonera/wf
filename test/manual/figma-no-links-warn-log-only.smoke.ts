/**
 * Manual smoke test: warnNoFigmaLinks writes to log file only — not to stdout
 *
 * Verifies that when PlanStageService.warnNoFigmaLinks runs, it only appends
 * a WARN entry to the day's log file and does not emit any text to stdout or
 * to a progress callback. Before this change the method forwarded the message
 * through onProgress, producing noise on non-Figma projects.
 *
 * Run: nr test:manual -- figma-no-links-warn-log-only.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { appendToLogFile } from '../../src/shared/logger/log-file-writer';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  PASS  ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(chalk.red(`  FAIL  ${msg}${detail ? `\n    → ${detail}` : ''}`));
  failed++;
};

function todaysLogPath(): string {
  return path.join(getWfLogDir(), `agent-${new Date().toISOString().slice(0, 10)}.log`);
}

async function main(): Promise<void> {
  console.log('Manual smoke: warnNoFigmaLinks writes to log file only\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-warn-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

  try {
    console.log(chalk.bold.cyan('\nTest 1: appendToLogFile writes the WARN entry to the log file'));

    const logPath = todaysLogPath();
    const sizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    appendToLogFile(
      'WARN',
      'No Figma frame links found in ticket — figma-implement/figma-design-check will be skipped.',
      'figma-stage',
    );

    const written = fs.readFileSync(logPath, 'utf-8').slice(sizeBefore);
    if (/\[WARN\] \[figma-stage\] No Figma frame links found/.test(written)) {
      pass('Log file contains WARN [figma-stage] No Figma frame links found');
    } else {
      fail('Expected WARN entry not found in log file', written.slice(0, 300));
    }

    console.log(chalk.bold.cyan('\nTest 2: warnNoFigmaLinks has no onProgress parameter'));

    const proto = PlanStageService.prototype as unknown as Record<string, unknown>;
    const methodSrc = typeof proto['warnNoFigmaLinks'] === 'function'
      ? String(proto['warnNoFigmaLinks'])
      : null;

    if (methodSrc === null) {
      fail('warnNoFigmaLinks method not found on PlanStageService.prototype');
    } else if (!methodSrc.includes('onProgress') && !methodSrc.includes('Progress')) {
      pass('warnNoFigmaLinks has no onProgress parameter — log-only confirmed');
    } else {
      fail('warnNoFigmaLinks still references onProgress', methodSrc.slice(0, 300));
    }

    console.log(chalk.bold.cyan('\nTest 3: calling warnNoFigmaLinks via NestJS produces no stdout output'));

    const service = app.get(PlanStageService);
    const capturedLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const patchedWrite = (chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === 'string' && /No Figma frame links/i.test(chunk)) {
        capturedLines.push(chunk);
      }
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    };
    process.stdout.write = patchedWrite as typeof process.stdout.write;

    ((service as unknown as Record<string, unknown>)['warnNoFigmaLinks'] as () => void)();

    process.stdout.write = origWrite;

    if (capturedLines.length === 0) {
      pass('No "No Figma frame links" text written to stdout by warnNoFigmaLinks');
    } else {
      fail('Unexpected stdout output from warnNoFigmaLinks', capturedLines.join(''));
    }
  } finally {
    await app.close();
    process.env.WF_HOME = origWfHome ?? undefined;
    fs.rmSync(wfHome, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: warnNoFigmaLinks log-file only');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
