/**
 * Manual smoke test: UiDesignScreenshotsStageService encodes files with correct mediaType
 *
 * Verifies that `encodeFromPaths` reads real image files from disk, base64-encodes
 * their content faithfully, and derives `mediaType` from the file extension across
 * all seven supported types. A missing file must be skipped with a WARN (not thrown).
 * An empty input must return empty arrays.
 *
 * Run: nr test:manual -- ui-design-screenshots-encode.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { UiDesignScreenshotsStageService } from '../../src/review/ui-design-screenshots-stage.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const FIXTURE_BYTES = Buffer.from([0x01, 0x02, 0x03, 0x04]);

function writeFixture(dir: string, name: string, content = FIXTURE_BYTES): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function main(): Promise<void> {
  console.log('Manual smoke: UiDesignScreenshotsStageService encodes files with correct mediaType\n');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-encode-ui-'));
  const tmpWfHome = path.join(tmpRoot, 'wfhome');
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = tmpWfHome;

  try {
    const service = new UiDesignScreenshotsStageService();

    console.log(chalk.bold.cyan('\nTest 1: PNG file → mediaType image/png, base64 round-trips'));
    {
      const p = writeFixture(tmpRoot, 'hero.png');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/png') {
        pass('mediaType is image/png');
      } else {
        fail('wrong mediaType', screenshots[0]?.mediaType);
      }
      const decoded = Buffer.from(screenshots[0].base64, 'base64');
      if (decoded.equals(FIXTURE_BYTES)) {
        pass('base64 round-trips to original bytes');
      } else {
        fail('base64 round-trip failed', `expected ${FIXTURE_BYTES.toString('hex')}, got ${decoded.toString('hex')}`);
      }
      if (screenshots[0].path === p) {
        pass('path field preserved unchanged');
      } else {
        fail('path field wrong', screenshots[0].path);
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: .jpg extension → mediaType image/jpeg'));
    {
      const p = writeFixture(tmpRoot, 'a.jpg');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/jpeg') {
        pass('.jpg → image/jpeg');
      } else {
        fail('.jpg produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 3: .jpeg extension → mediaType image/jpeg'));
    {
      const p = writeFixture(tmpRoot, 'b.jpeg');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/jpeg') {
        pass('.jpeg → image/jpeg');
      } else {
        fail('.jpeg produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 4: .webp extension → mediaType image/webp'));
    {
      const p = writeFixture(tmpRoot, 'c.webp');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/webp') {
        pass('.webp → image/webp');
      } else {
        fail('.webp produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 5: .tif extension → mediaType image/tiff'));
    {
      const p = writeFixture(tmpRoot, 'd.tif');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/tiff') {
        pass('.tif → image/tiff');
      } else {
        fail('.tif produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 6: .tiff extension → mediaType image/tiff'));
    {
      const p = writeFixture(tmpRoot, 'e.tiff');
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/tiff') {
        pass('.tiff → image/tiff');
      } else {
        fail('.tiff produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 7: .svg extension → mediaType image/svg+xml'));
    {
      const p = writeFixture(tmpRoot, 'f.svg', Buffer.from('<svg/>'));
      const { screenshots } = service.encodeFromPaths([p]);
      if (screenshots.length === 1 && screenshots[0].mediaType === 'image/svg+xml') {
        pass('.svg → image/svg+xml');
      } else {
        fail('.svg produced wrong mediaType', screenshots[0]?.mediaType);
      }
    }

    console.log(chalk.bold.cyan('\nTest 8: missing file is skipped; WARN written to log'));
    {
      const missing = path.join(tmpRoot, 'ghost.png');
      const existing = writeFixture(tmpRoot, 'real.png');
      const { screenshots, paths } = service.encodeFromPaths([missing, existing]);
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
      const logDir = path.join(tmpWfHome, 'logs');
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

    console.log(chalk.bold.cyan('\nTest 9: empty input returns empty arrays'));
    {
      const { screenshots, paths } = service.encodeFromPaths([]);
      if (screenshots.length === 0 && paths.length === 0) {
        pass('encodeFromPaths([]) returns { screenshots: [], paths: [] }');
      } else {
        fail('expected empty arrays', JSON.stringify({ screenshots, paths }));
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (origWfHome === undefined) {
      delete process.env.WF_HOME;
    } else {
      process.env.WF_HOME = origWfHome;
    }
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: UiDesignScreenshotsStageService encodes files with correct mediaType');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
