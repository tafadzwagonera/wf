/**
 * Manual Test: stageAll() excludes .wf/** and wf.config.* tooling artifacts
 *
 * Run: nr test:manual -- test-stage-all-exclusions
 *
 * Verifies:
 *   1. .wf/** runtime artifacts are excluded from staging
 *   2. All six wf.config.* file variants are excluded from staging
 *   3. dist/ build output is excluded from staging
 *   4. .gitignore is excluded from staging
 *   5. Real source files ARE staged (exclusions are not too broad)
 *
 * No AI / API keys required — exercises GitService.stageAll() directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  let tmpDir: string | undefined;

  try {
    // ── Set up temporary git repo ──────────────────────────────────────────
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-test-'));

    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });

    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');

    // Initial commit so HEAD exists
    const srcFile = path.join(tmpDir, 'index.ts');
    fs.writeFileSync(srcFile, 'export const hello = () => "hello";\n');
    git('add .');
    git('commit -m "init"');

    // ── Scenario: mix of real files, .wf/** artifacts, and wf.config.* ────
    console.log('\n🧪 stageAll() exclusion smoke test\n');
    console.log('─'.repeat(60));

    // Real code change
    fs.writeFileSync(srcFile, 'export const hello = () => "hello v2";\n');

    // .wf/** runtime artifacts
    const wfDir = path.join(tmpDir, '.wf', 'state');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'plan.json'), '{"key":"TEST-001"}');

    // All six wf.config.* variants
    const wfConfigFiles = [
      'wf.config.js',
      'wf.config.mjs',
      'wf.config.ts',
      'wf.config.mts',
      'wf.config.yaml',
      'wf.config.yml',
    ];
    for (const cfgFile of wfConfigFiles) {
      fs.writeFileSync(path.join(tmpDir, cfgFile), `// wf tooling artifact\nmodule.exports = {};\n`);
    }

    // dist/ build output
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), '"use strict";\n');

    // .gitignore — managed by repo owner, must not be staged by wf
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');

    // ── Call stageAll ──────────────────────────────────────────────────────
    const gitService = app.get(GitService);
    await gitService.stageAll(tmpDir);

    // Check what was staged
    const staged = execSync('git diff --cached --name-only', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();

    console.log('\nStaged files:\n' + (staged || '(none)') + '\n');

    // ── Assertions ────────────────────────────────────────────────────────

    // 1. Real source file IS staged
    if (staged.includes('index.ts')) {
      pass('index.ts (real code change) WAS staged');
    } else {
      fail('index.ts was NOT staged — exclusion is too broad', staged);
    }

    // 2. .wf/** is NOT staged
    if (!staged.includes('.wf/')) {
      pass('.wf/** runtime artifacts were NOT staged');
    } else {
      fail('.wf/** artifacts leaked into staged files', staged);
    }

    // 3. Each wf.config.* variant is NOT staged
    for (const cfgFile of wfConfigFiles) {
      if (!staged.includes(cfgFile)) {
        pass(`${cfgFile} was NOT staged`);
      } else {
        fail(`${cfgFile} leaked into staged files`, staged);
      }
    }

    // 4. dist/ build output is NOT staged
    if (!staged.includes('dist/')) {
      pass('dist/ build output was NOT staged');
    } else {
      fail('dist/ build output leaked into staged files', staged);
    }

    // 5. .gitignore is NOT staged
    if (!staged.includes('.gitignore')) {
      pass('.gitignore was NOT staged');
    } else {
      fail('.gitignore leaked into staged files', staged);
    }
  } finally {
    await app.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━'.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
