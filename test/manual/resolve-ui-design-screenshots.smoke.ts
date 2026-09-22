/**
 * Manual smoke test: resolveUiDesignScreenshots path-resolution modes
 *
 * Verifies that `resolveUiDesignScreenshots` applies three distinct resolution modes
 * (no-arg directory scan, single-arg file/directory, multi-arg explicit list) with
 * real filesystem I/O, filters out unsupported extensions, logs a WARN when the scan
 * directory is missing, and throws `FileSystemError` for missing explicit files.
 *
 * Run: nr test:manual resolve-ui-design-screenshots.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { resolveUiDesignScreenshots } from '../../src/shared/utils/resolve-ui-design-screenshots';
import { FileSystemError } from '../../src/shared/errors/app.error';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkNoArgMode(artifactDir: string, identifier: string): void {
  const result = resolveUiDesignScreenshots([], artifactDir, identifier);
  const names = result.map(p => path.basename(p)).sort();
  if (names.length === 2 && names.includes('hero.png') && names.includes('banner.jpg')) {
    pass('returned hero.png and banner.jpg; notes.txt excluded');
  } else {
    fail('unexpected result set', JSON.stringify(names));
  }
}

function checkWarnLogEntry(tmpWfHome: string): void {
  const logDir = path.join(tmpWfHome, 'logs');
  const logFile = fs.existsSync(logDir) ? fs.readdirSync(logDir).find(f => f.startsWith('agent-')) : undefined;
  const logContent = logFile ? fs.readFileSync(path.join(logDir, logFile), 'utf-8') : '';
  if (logContent.includes('scan directory not found')) {
    pass('WARN "scan directory not found" written to log');
  } else {
    fail('WARN not found in log', logContent.slice(0, 300));
  }
}

function checkNoArgMissingDir(tmpRoot: string, tmpWfHome: string): void {
  const emptyArtifactDir = path.join(tmpRoot, 'empty-artifacts');
  fs.mkdirSync(emptyArtifactDir, { recursive: true });
  const result = resolveUiDesignScreenshots([], emptyArtifactDir, 'MISSING-1');
  if (result.length === 0) {
    pass('returns [] when scan directory does not exist');
  } else {
    fail('expected [] but got paths', JSON.stringify(result));
  }
  checkWarnLogEntry(tmpWfHome);
}

function checkSingleArgDirMode(tmpRoot: string, artifactDir: string, identifier: string): void {
  const subDir = path.join(tmpRoot, 'shots');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'a.webp'), Buffer.alloc(4));
  fs.writeFileSync(path.join(subDir, 'b.svg'), '<svg/>');
  const result = resolveUiDesignScreenshots([subDir], artifactDir, identifier);
  const names = result.map(p => path.basename(p)).sort();
  if (names.length === 2 && names.includes('a.webp') && names.includes('b.svg')) {
    pass('single-arg dir mode returns a.webp and b.svg');
  } else {
    fail('unexpected result set', JSON.stringify(names));
  }
}

function checkSingleArgFileMode(scanDir: string, artifactDir: string, identifier: string): void {
  const filePath = path.join(scanDir, 'hero.png');
  const result = resolveUiDesignScreenshots([filePath], artifactDir, identifier);
  if (result.length === 1 && result[0] === filePath) {
    pass('single-arg file returns exactly that path');
  } else {
    fail('unexpected result', JSON.stringify(result));
  }
}

function checkMultiArgMode(scanDir: string, artifactDir: string, identifier: string): void {
  const pngPath = path.join(scanDir, 'hero.png');
  const jpgPath = path.join(scanDir, 'banner.jpg');
  const txtPath = path.join(scanDir, 'notes.txt');
  const result = resolveUiDesignScreenshots([pngPath, jpgPath, txtPath], artifactDir, identifier);
  if (result.length === 2 && result.includes(pngPath) && result.includes(jpgPath)) {
    pass('hero.png and banner.jpg included; notes.txt skipped');
  } else {
    fail('unexpected result', JSON.stringify(result));
  }
}

function checkMissingFileThrows(tmpRoot: string, artifactDir: string, identifier: string): void {
  const missing = path.join(tmpRoot, 'ghost.png');
  let threw = false;
  try {
    resolveUiDesignScreenshots([missing], artifactDir, identifier);
  } catch (err) {
    threw = err instanceof FileSystemError;
  }
  if (threw) {
    pass('missing explicit file throws FileSystemError');
  } else {
    fail('expected FileSystemError but no error was thrown');
  }
}

function setupScanDir(tmpRoot: string): { artifactDir: string; identifier: string; scanDir: string } {
  const artifactDir = path.join(tmpRoot, 'artifacts');
  const identifier = 'TICKET-1';
  const scanDir = path.join(artifactDir, identifier);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'hero.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(scanDir, 'banner.jpg'), Buffer.from([0xff, 0xd8]));
  fs.writeFileSync(path.join(scanDir, 'notes.txt'), 'not an image');
  return { artifactDir, identifier, scanDir };
}

async function runScenario(tmpRoot: string, tmpWfHome: string): Promise<void> {
  const { artifactDir, identifier, scanDir } = setupScanDir(tmpRoot);
  console.log(chalk.bold.cyan('\nTest 1: no-arg mode returns only supported-extension files from scan dir'));
  checkNoArgMode(artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 2: no-arg mode returns [] when scan dir missing; WARN logged'));
  checkNoArgMissingDir(tmpRoot, tmpWfHome);
  console.log(chalk.bold.cyan('\nTest 3: single-arg directory mode scans that directory'));
  checkSingleArgDirMode(tmpRoot, artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 4: single-arg file mode returns exactly that file'));
  checkSingleArgFileMode(scanDir, artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 5: multi-arg mode resolves valid paths; unsupported extension skipped with WARN'));
  checkMultiArgMode(scanDir, artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 6: missing explicit file throws FileSystemError'));
  checkMissingFileThrows(tmpRoot, artifactDir, identifier);
}

function restoreEnv(origWfHome: string | undefined): void {
  if (origWfHome === undefined) {
    delete process.env.WF_HOME;
  } else {
    process.env.WF_HOME = origWfHome;
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: resolveUiDesignScreenshots path-resolution modes\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-resolve-ui-'));
  const tmpWfHome = path.join(tmpRoot, 'wfhome');
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = tmpWfHome;
  try {
    await runScenario(tmpRoot, tmpWfHome);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(origWfHome);
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
