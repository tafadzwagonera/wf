/**
 * Manual smoke test: UiDesignScreenshotsStageService encodes files with correct mediaType
 *
 * Verifies that `encodeFromPaths` reads real image files from disk, base64-encodes
 * their content faithfully, and derives `mediaType` from the file extension across
 * all seven supported types. A missing file must be skipped with a WARN (not thrown).
 * An empty input must return empty arrays.
 *
 * Run: nr test:manual ui-design-screenshots-encode.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { UiDesignScreenshotsStageService } from '../../src/review/ui-design-screenshots-stage.service';
import { restoreEnv, withEnv } from '../../src/shared/testing/env';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const fixtureBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);

type EncodeResult = ReturnType<UiDesignScreenshotsStageService['encodeFromPaths']>;
type Screenshot = EncodeResult['screenshots'][0];

function writeFixture(
  dir: string,
  name: string,
  content: Buffer = fixtureBytes,
): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function checkExtensionResult(ext: string, screenshots: Screenshot[], expectedType: string): void {
  if (screenshots.length === 1 && screenshots[0].mediaType === expectedType) {
    pass(`${ext} → ${expectedType}`);
  } else {
    fail(`${ext} produced wrong mediaType`, screenshots[0]?.mediaType);
  }
}

function testExtension(
  service: UiDesignScreenshotsStageService,
  dir: string,
  filename: string,
  expectedType: string,
  content?: Buffer<ArrayBuffer>,
): void {
  const ext = path.extname(filename);
  const p = writeFixture(dir, filename, content);
  const { screenshots } = service.encodeFromPaths([p]);
  checkExtensionResult(ext, screenshots, expectedType);
}

function checkPngScreenshot(
  service: UiDesignScreenshotsStageService,
  dir: string,
): { p: string; screenshot: Screenshot } {
  console.log(chalk.bold.cyan('\nTest 1: PNG file → mediaType image/png, base64 round-trips'));
  const p = writeFixture(dir, 'hero.png');
  const { screenshots } = service.encodeFromPaths([p]);
  if (screenshots.length === 1 && screenshots[0].mediaType === 'image/png') {
    pass('mediaType is image/png');
  } else {
    fail('wrong mediaType', screenshots[0]?.mediaType);
  }
  return { p, screenshot: screenshots[0] };
}

function checkBase64AndPath(p: string, screenshot: Screenshot): void {
  const decoded = Buffer.from(screenshot.base64, 'base64');
  if (decoded.equals(fixtureBytes)) {
    pass('base64 round-trips to original bytes');
  } else {
    const expected = fixtureBytes.toString('hex');
    const got = decoded.toString('hex');
    fail('base64 round-trip failed', `expected ${expected}, got ${got}`);
  }
  if (screenshot.path === p) {
    pass('path field preserved unchanged');
  } else {
    fail('path field wrong', screenshot.path);
  }
}

function checkWarnLog(wfHome: string): void {
  const logDir = path.join(wfHome, 'logs');
  const logFile = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).find(f => f.startsWith('agent-'))
    : undefined;
  const logContent = logFile ? fs.readFileSync(path.join(logDir, logFile), 'utf-8') : '';
  if (logContent.includes('file not found at encode time')) {
    pass('WARN "file not found at encode time" written to log');
  } else {
    fail('WARN not found in log', logContent.slice(0, 300));
  }
}

function checkMissingFileResults(screenshots: Screenshot[], paths: string[], existing: string): void {
  if (screenshots.length === 1 && screenshots[0].path === existing) {
    pass('missing file absent from screenshots; existing file present');
  } else {
    fail('unexpected screenshots array', JSON.stringify(screenshots.map(s => s.path)));
  }
  if (paths.length === 1 && paths[0] === existing) {
    pass('paths array mirrors screenshots (missing file excluded)');
  } else {
    fail('unexpected paths array', JSON.stringify(paths));
  }
}

function runMissingFileTest(
  service: UiDesignScreenshotsStageService,
  tmpRoot: string,
  tmpWfHome: string,
): void {
  const missing = path.join(tmpRoot, 'ghost.png');
  const existing = writeFixture(tmpRoot, 'real.png');
  const { screenshots, paths } = service.encodeFromPaths([missing, existing]);
  checkMissingFileResults(screenshots, paths, existing);
  checkWarnLog(tmpWfHome);
}

function runTest8(
  service: UiDesignScreenshotsStageService,
  tmpRoot: string,
  tmpWfHome: string,
): void {
  console.log(chalk.bold.cyan('\nTest 8: missing file is skipped; WARN written to log'));
  runMissingFileTest(service, tmpRoot, tmpWfHome);
}

function runTest9(service: UiDesignScreenshotsStageService): void {
  console.log(chalk.bold.cyan('\nTest 9: empty input returns empty arrays'));
  const { screenshots, paths } = service.encodeFromPaths([]);
  if (screenshots.length === 0 && paths.length === 0) {
    pass('encodeFromPaths([]) returns { screenshots: [], paths: [] }');
  } else {
    fail('expected empty arrays', JSON.stringify({ screenshots, paths }));
  }
}

function cleanupEnv(tmpRoot: string): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  restoreEnv();
}

function testAllExtensions(service: UiDesignScreenshotsStageService, tmpRoot: string): void {
  testExtension(service, tmpRoot, 'a.jpg', 'image/jpeg');
  testExtension(service, tmpRoot, 'b.jpeg', 'image/jpeg');
  testExtension(service, tmpRoot, 'c.webp', 'image/webp');
  testExtension(service, tmpRoot, 'd.tif', 'image/tiff');
  testExtension(service, tmpRoot, 'e.tiff', 'image/tiff');
  testExtension(service, tmpRoot, 'f.svg', 'image/svg+xml', Buffer.from('<svg/>'));
}

function runAllTests(service: UiDesignScreenshotsStageService, tmpRoot: string, tmpWfHome: string): void {
  const { p, screenshot } = checkPngScreenshot(service, tmpRoot);
  checkBase64AndPath(p, screenshot);
  testAllExtensions(service, tmpRoot);
  runTest8(service, tmpRoot, tmpWfHome);
  runTest9(service);
}

function setupTestEnv(): { tmpRoot: string; tmpWfHome: string } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-encode-ui-'));
  const tmpWfHome = path.join(tmpRoot, 'wfhome');
  withEnv({ WF_HOME: tmpWfHome });
  return { tmpRoot, tmpWfHome };
}

function logTestResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  console.log('\nManual smoke test passed: UiDesignScreenshotsStageService encodes files with correct mediaType');
}

async function main(): Promise<void> {
  console.log('Manual smoke: UiDesignScreenshotsStageService encodes files with correct mediaType\n');
  const { tmpRoot, tmpWfHome } = setupTestEnv();
  try {
    runAllTests(new UiDesignScreenshotsStageService(), tmpRoot, tmpWfHome);
  } finally {
    cleanupEnv(tmpRoot);
  }
  if (counts.failed > 0) process.exit(1);
  logTestResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
