/**
 * Manual smoke test: push() protected branch guard via real NestJS DI + git
 *
 * Scope: guard logic (prefix stripping, case matching, custom config, empty
 * array opt-out) is exhaustively covered by the Jest unit test in
 * src/integrations/git/git.service.spec.ts. This manual test only verifies
 * live side effects that mocks cannot cover:
 *   1. Guard fires correctly through real NestJS DI wiring (not just mocks)
 *   2. An allowed branch actually pushes to a real git remote
 *
 * No AI / API keys required — exercises GitService.push() directly.
 *
 * Run: nr test:manual -- test-push-protected-branch-guard
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { GitError } from '../../src/shared/errors/app.error';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

const pass = (msg: string) => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

async function main() {
  let tmpDir: string | undefined;
  let bareDir: string | undefined;
  const origCwd = process.cwd();

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-push-guard-'));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-push-guard-bare-'));

    const git = (cmd: string, cwd: string = tmpDir!) =>
      execSync(`git ${cmd}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });

    git('init --bare', bareDir);
    git('init -b main');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    git(`remote add origin ${bareDir}`);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
    git('add .');
    git('commit -m "init"');
    git('push -u origin main');
    git('checkout -b feature/foo');
    fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature work\n');
    git('add .');
    git('commit -m "feature work"');
    git('checkout main');

    // chdir so simpleGit() inside GitService picks up the temp repo
    process.chdir(tmpDir);

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error'],
    });

    console.log('\nSmoke test: push() protected branch guard (live side effects)\n');
    console.log('\u2500'.repeat(60));

    const gitService = app.get(GitService);

    console.log('\n  Real DI wiring:');

    await assertPushRefused(gitService, 'main', '1. push to main is refused via real DI');

    console.log('\n  Real git push:');

    git('checkout feature/foo', tmpDir);
    try {
      await gitService.push('origin', 'feature/foo', true);
      pass('2. push to feature/foo succeeds against real remote');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail('2. push to feature/foo should succeed', msg);
    }

    await app.close();
  } finally {
    process.chdir(origCwd);
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (bareDir && fs.existsSync(bareDir)) {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  }

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) {
    console.log('All tests passed!');
  }
  console.log('\u2501'.repeat(60));

  if (failed > 0) process.exit(1);
}

async function assertPushRefused(
  gitService: GitService,
  branch: string,
  label: string
): Promise<void> {
  try {
    await gitService.push('origin', branch);
    fail(label, `Expected GitError but push() resolved for branch '${branch}'`);
  } catch (err) {
    const isGuardError
      = err instanceof GitError
        && err.message.includes('Refusing to push directly to protected branch');
    if (isGuardError) {
      pass(label);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      fail(label, `Wrong error type or message: ${msg}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
