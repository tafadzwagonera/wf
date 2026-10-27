/**
 * Manual smoke test: resolveUiDesignScreenshots path-resolution modes
 *
 * Verifies that `resolveUiDesignScreenshots` applies three distinct resolution modes
 * (no-arg directory scan, single-arg file/directory, multi-arg explicit list) with
 * real filesystem I/O, filters out unsupported extensions, logs a WARN when the scan
 * directory is missing, and throws `FileSystemError` for missing explicit files.
 *
 * Also verifies that a non-ASCII screenshot basename (e.g. a real macOS screenshot
 * name containing U+202F) is sanitized to a model-safe ASCII path backed by a real
 * copy in a `.wf-safe/` sibling directory, that the original file is left completely
 * untouched, that no `.wf-safe/` directory is created when every scanned file is
 * already ASCII-named, and that resolving the same non-ASCII fixture twice is
 * idempotent.
 *
 * Run: nr test:manual resolve-ui-design-screenshots.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { resolveUiDesignScreenshots } from '../../src/common/utils/resolve-ui-design-screenshots';
import { FileSystemError } from '../../src/common/errors/app.error';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

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

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

type NonAsciiFixture = {
  artifactDir: string;
  identifier: string;
  scanDir: string;
  nonAsciiPath: string;
  asciiPath: string;
  nonAsciiBytes: Buffer;
};

function setupNonAsciiScanDir(tmpWfHome: string): NonAsciiFixture {
  const artifactDir = path.join(tmpWfHome, 'source-artifacts');
  const identifier = 'TICKET-NONASCII';
  const scanDir = path.join(tmpWfHome, 'source-artifacts', identifier);
  fs.mkdirSync(scanDir, { recursive: true });
  const nonAsciiBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const nonAsciiPath = path.join(scanDir, 'Screenshot 2026-10-16 at 4.55.50 pm.png');
  const asciiPath = path.join(scanDir, 'plain-name.png');
  fs.writeFileSync(nonAsciiPath, nonAsciiBytes);
  fs.writeFileSync(asciiPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  return { artifactDir, identifier, scanDir, nonAsciiPath, asciiPath, nonAsciiBytes };
}

function checkNonAsciiSanitizedShape(fixture: NonAsciiFixture): string | undefined {
  const { artifactDir, identifier, scanDir, asciiPath } = fixture;
  const result = resolveUiDesignScreenshots([], artifactDir, identifier);
  const safePath = result.find(p => p !== asciiPath);
  const safeBasename = safePath ? path.basename(safePath) : '';
  const isUnderSafeDir = safePath ? path.dirname(safePath) === path.join(scanDir, '.wf-safe') : false;
  const isValidShape = result.length === 2 && result.includes(asciiPath)
    && PRINTABLE_ASCII.test(safeBasename) && isUnderSafeDir;
  if (!isValidShape) {
    fail('expected one unchanged ASCII path and one sanitized safe path', JSON.stringify(result));
    return undefined;
  }
  pass(`non-ASCII screenshot sanitized to ASCII-safe path under .wf-safe/: ${safeBasename}`);
  return safePath;
}

function checkSafePathContentMatches(safePath: string | undefined, nonAsciiBytes: Buffer): void {
  if (safePath && fs.readFileSync(safePath).equals(nonAsciiBytes)) {
    pass('safe-path copy has byte-identical content to the original');
  } else {
    fail('safe-path copy content does not match original bytes');
  }
}

function checkOriginalNonAsciiFileIntact(fixture: NonAsciiFixture): void {
  const { nonAsciiPath, nonAsciiBytes } = fixture;
  const stillExists = fs.existsSync(nonAsciiPath);
  const bytesMatch = stillExists && fs.readFileSync(nonAsciiPath).equals(nonAsciiBytes);
  if (stillExists && bytesMatch) {
    pass('original non-ASCII-named file untouched at its original path with original bytes');
  } else {
    fail('original non-ASCII file was modified, renamed, or deleted', `exists=${stillExists}`);
  }
}

function checkNoSafeDirForAllAsciiScan(tmpWfHome: string): void {
  const artifactDir = path.join(tmpWfHome, 'ascii-only-artifacts');
  const identifier = 'TICKET-ASCII-ONLY';
  const scanDir = path.join(tmpWfHome, 'ascii-only-artifacts', identifier);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'plain-name.png'), Buffer.from([0x89, 0x50]));
  resolveUiDesignScreenshots([], artifactDir, identifier);
  if (fs.existsSync(path.join(scanDir, '.wf-safe'))) {
    fail('.wf-safe/ was created even though every scanned file was already ASCII-named');
  } else {
    pass('.wf-safe/ not created when every scanned file is already ASCII-named');
  }
}

function checkNonAsciiSanitizationIsIdempotent(fixture: NonAsciiFixture, firstSafePath: string | undefined): void {
  const { artifactDir, identifier, asciiPath } = fixture;
  if (!firstSafePath) {
    fail('skipping idempotency check: first sanitization run did not produce a safe path');
    return;
  }
  const result = resolveUiDesignScreenshots([], artifactDir, identifier);
  const safePath = result.find(p => p !== asciiPath);
  if (safePath === firstSafePath) {
    pass('re-running resolution against the same fixture returns the same safe path');
  } else {
    fail('safe path changed between runs', JSON.stringify({ firstSafePath, safePath }));
  }
}

type ScanDirFixture = { artifactDir: string; identifier: string; scanDir: string };

function setupScanDir(tmpRoot: string, tmpWfHome: string): ScanDirFixture {
  const artifactDir = path.join(tmpRoot, 'artifacts');
  const identifier = 'TICKET-1';
  const scanDir = path.join(tmpWfHome, 'artifacts', identifier);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'hero.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(scanDir, 'banner.jpg'), Buffer.from([0xff, 0xd8]));
  fs.writeFileSync(path.join(scanDir, 'notes.txt'), 'not an image');
  return { artifactDir, identifier, scanDir };
}

async function runScenario(tmpRoot: string, tmpWfHome: string): Promise<void> {
  const { artifactDir, identifier, scanDir } = setupScanDir(tmpRoot, tmpWfHome);
  console.log(chalk.bold.cyan('\nTest 1: no-arg mode returns only supported-extension files from scan dir'));
  checkNoArgMode(artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 2: no-arg mode returns [] when scan dir missing; WARN logged'));
  checkNoArgMissingDir(tmpRoot, tmpWfHome);
  console.log(chalk.bold.cyan('\nTest 3: single-arg directory mode scans that directory'));
  checkSingleArgDirMode(tmpRoot, artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 4: single-arg file mode returns exactly that file'));
  checkSingleArgFileMode(scanDir, artifactDir, identifier);
  runExplicitListAndSanitizationScenario(tmpRoot, scanDir, artifactDir, identifier, tmpWfHome);
}

function runExplicitListAndSanitizationScenario(
  tmpRoot: string, scanDir: string, artifactDir: string, identifier: string, tmpWfHome: string,
): void {
  console.log(chalk.bold.cyan('\nTest 5: multi-arg mode resolves valid paths; unsupported extension skipped with WARN'));
  checkMultiArgMode(scanDir, artifactDir, identifier);
  console.log(chalk.bold.cyan('\nTest 6: missing explicit file throws FileSystemError'));
  checkMissingFileThrows(tmpRoot, artifactDir, identifier);
  runNonAsciiSanitizationScenario(tmpWfHome);
}

function runNonAsciiSanitizationScenario(tmpWfHome: string): void {
  const nonAsciiFixture = setupNonAsciiScanDir(tmpWfHome);
  console.log(chalk.bold.cyan('\nTest 7: non-ASCII screenshot basename sanitized to a model-safe copy'));
  const safePath = checkNonAsciiSanitizedShape(nonAsciiFixture);
  checkSafePathContentMatches(safePath, nonAsciiFixture.nonAsciiBytes);
  checkOriginalNonAsciiFileIntact(nonAsciiFixture);
  console.log(chalk.bold.cyan('\nTest 8: no .wf-safe/ created when every scanned file is ASCII-named'));
  checkNoSafeDirForAllAsciiScan(tmpWfHome);
  console.log(chalk.bold.cyan('\nTest 9: re-resolving the same non-ASCII fixture is idempotent'));
  checkNonAsciiSanitizationIsIdempotent(nonAsciiFixture, safePath);
}

async function main(): Promise<void> {
  console.log('Manual smoke: resolveUiDesignScreenshots path-resolution modes\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-resolve-ui-'));
  const tmpWfHome = path.join(tmpRoot, 'wfhome');
  withEnv({ WF_HOME: tmpWfHome });
  try {
    await runScenario(tmpRoot, tmpWfHome);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
