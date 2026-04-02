/**
 * Manual test: issue API alignment
 *
 * Run: nr test:manual -- test-issue-api-alignment
 *
 * Verifies:
 *   1. --chat-mode flag is accepted (dry-run exits 0)
 *   2. --interactive flag is rejected (unknown option)
 *   3. --skip-existing flag is rejected (unknown option)
 *   4. -f / --force flag is accepted (dry-run exits 0)
 *   5. Without --force, dry-run skips FETCH stage when artifact exists (idempotent default)
 *   6. With --force, dry-run shows "overwrite" even when artifact exists
 *
 * Tests 1–4 call `node dist/main.js` — requires a recent `yarn build`.
 * Tests 5–6 call command.run() directly via NestFactory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';

async function main() {
  console.log(chalk.bold.cyan('\n🧪 issue API alignment tests\n'));

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(chalk.green(`  ✓ ${msg}\n`));
    passed++;
  };
  const fail = (msg: string) => {
    console.error(chalk.red(`  ✗ ${msg}\n`));
    failed++;
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Absolute path to dist/main.js so it can be invoked from a temp dir,
  // avoiding wf.config.ts in the project root which breaks Node.js loading.
  const distMain = path.join(__dirname, '../../dist/main.js');

  /**
   * Run `node dist/main.js issue <args>` and return stdout+stderr and exit code.
   */
  const runCli = (args: string): { output: string; exitCode: number } => {
    try {
      const output = execSync(`node ${distMain} issue ${args}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: os.tmpdir(),
        timeout: 15_000,
      });
      return { output, exitCode: 0 };
    } catch (err: any) {
      return {
        output: (err.stdout ?? '') + (err.stderr ?? ''),
        exitCode: err.status ?? 1,
      };
    }
  };

  /**
   * Create a temp dir and seed a ticket artifact in the location that
   * resolveArtifactDir() will look for it: ~/.wf/<basename(tmpRoot)>/jira/.
   */
  const makeArtifactFixture = (
    ticketKey: string,
  ): { tmpRoot: string; homeDir: string; cleanup: () => void } => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-align-'));
    const homeDir = path.join(tmpRoot, 'home');
    // resolveArtifactDir resolves to: getWfHomeDir() / basename(baseDir) / platform
    // When cwd=tmpRoot and repo='test-repo' is not found, baseDir=cwd=tmpRoot.
    const wfHome = path.join(homeDir, '.wf');
    const platformDir = path.join(wfHome, path.basename(tmpRoot), 'jira');
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(
      path.join(platformDir, `${ticketKey}.md`),
      `# ${ticketKey}: Fixture ticket\n`,
      'utf-8',
    );
    return {
      tmpRoot,
      homeDir,
      cleanup: () => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      },
    };
  };

  /**
   * Capture stdout written during an async fn call.
   */
  const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return original(chunk, ...rest);
    };
    try {
      await fn();
    } finally {
      (process.stdout.write as any) = original;
    }
    return chunks.join('');
  };

  // ── CLI flag tests (require `yarn build`) ────────────────────────────────

  console.log(chalk.bold('Test 1: --chat-mode flag is accepted'));
  {
    const { exitCode } = runCli(
      'TEST-1 --from fetch --to fetch --repos test-repo --dry-run --chat-mode',
    );
    if (exitCode === 0) {
      pass('--chat-mode accepted; dry-run exited 0');
    } else {
      fail(`--chat-mode: dry-run exited ${exitCode}`);
    }
  }

  console.log(chalk.bold('Test 2: --interactive flag is rejected'));
  {
    const { exitCode, output } = runCli(
      'TEST-2 --from fetch --to fetch --repos test-repo --dry-run --interactive',
    );
    if (exitCode !== 0 || output.toLowerCase().includes('unknown option')) {
      pass('--interactive correctly rejected');
    } else {
      fail(
        `--interactive was accepted (exit ${exitCode}) — old flag still registered`,
      );
    }
  }

  console.log(chalk.bold('Test 3: --skip-existing flag is rejected'));
  {
    const { exitCode, output } = runCli(
      'TEST-3 --from fetch --to fetch --repos test-repo --dry-run --skip-existing',
    );
    if (exitCode !== 0 || output.toLowerCase().includes('unknown option')) {
      pass('--skip-existing correctly rejected');
    } else {
      fail(
        `--skip-existing was accepted (exit ${exitCode}) — old flag still registered`,
      );
    }
  }

  console.log(
    chalk.bold(
      'Test 4: --force accepted; -f rejected (no short form after CLI refactor)',
    ),
  );
  {
    const { exitCode: exitLong } = runCli(
      'TEST-4 --from fetch --to fetch --repos test-repo --dry-run --force',
    );
    const { exitCode: exitShort, output: shortOutput } = runCli(
      'TEST-4 --from fetch --to fetch --repos test-repo --dry-run -f',
    );
    const shortRejected =
      exitShort !== 0 || shortOutput.toLowerCase().includes('unknown option');
    if (exitLong === 0 && shortRejected) {
      pass(
        '--force accepted; -f correctly rejected (short form removed to avoid --format conflict)',
      );
    } else {
      fail(
        `--force exited ${exitLong} (expected 0); -f exited ${exitShort} rejected=${shortRejected} (expected true)`,
      );
    }
  }

  // ── Behaviour tests (NestFactory) ────────────────────────────────────────

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const command = app.get(IssueCommand);

  console.log(
    chalk.bold('Test 5: No --force → dry-run skips FETCH when artifact exists'),
  );
  {
    const { tmpRoot, homeDir, cleanup } = makeArtifactFixture('TEST-5');
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    process.chdir(tmpRoot);
    process.env.HOME = homeDir;
    try {
      const output = await captureStdout(() =>
        command.run(['TEST-5'], {
          from: 'fetch',
          to: 'fetch',
          repos: ['test-repo'],
          dryRun: true,
          // force undefined → skipExisting = true (idempotent)
        }),
      );
      if (output.toLowerCase().includes('skip')) {
        pass('Without --force, dry-run skips FETCH because artifact exists');
      } else {
        fail(`Expected "skip" in dry-run output but got:\n${output}`);
      }
    } catch (err: any) {
      fail(`Test 5 threw: ${err.message}`);
    } finally {
      process.chdir(originalCwd);
      process.env.HOME = originalHome;
      cleanup();
    }
  }

  console.log(
    chalk.bold(
      'Test 6: --force → dry-run overwrites even when artifact exists',
    ),
  );
  {
    const { tmpRoot, homeDir, cleanup } = makeArtifactFixture('TEST-6');
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    process.chdir(tmpRoot);
    process.env.HOME = homeDir;
    try {
      const output = await captureStdout(() =>
        command.run(['TEST-6'], {
          from: 'fetch',
          to: 'fetch',
          repos: ['test-repo'],
          dryRun: true,
          force: true, // skipExisting = false → should show overwrite
        }),
      );
      if (output.toLowerCase().includes('overwrite')) {
        pass('With --force, dry-run shows "overwrite" for FETCH stage');
      } else {
        fail(`Expected "overwrite" in dry-run output but got:\n${output}`);
      }
    } catch (err: any) {
      fail(`Test 6 threw: ${err.message}`);
    } finally {
      process.chdir(originalCwd);
      process.env.HOME = originalHome;
      cleanup();
    }
  }

  await app.close();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(chalk.gray('─'.repeat(60)));
  console.log(
    `Results: ${chalk.green(`✅ ${passed} passed`)}   ${chalk.red(`❌ ${failed} failed`)}`,
  );
  if (failed === 0) {
    console.log(chalk.bold.green('✅ All tests passed!\n'));
  }
  console.log(chalk.gray('─'.repeat(60)));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
