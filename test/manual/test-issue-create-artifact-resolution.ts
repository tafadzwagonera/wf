/**
 * Manual Test: issue:create artifact-only path resolution
 *
 * Run: nr test:manual -- test-issue-create-artifact-resolution
 *
 * Verifies:
 *   1. Bare filename resolves to ~/.wf/<basename(cwd)>/<tracker>/<filename>, not <cwd>/<filename>
 *   2. Absolute path passes through unchanged
 *   3. Missing bare filename error reports the artifact path, not the cwd path
 *   4. --repos scopes bare filename to ~/.wf/<repo>/<tracker>/<filename>
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCreateCommand } from '../../src/commands/issue-create.command';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(`  \u2713 ${message}`);
  passed++;
};

const fail = (message: string, detail?: string) => {
  console.error(`  \u2717 ${message}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

const TICKET_CONTENT = [
  '# Test artifact resolution',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  '',
  'Verifies artifact-only path resolution in readFromFile.',
].join('\n');

const wfHome = path.join(os.homedir(), '.wf');
const testId = `__test-create-artifact-${Date.now()}`;
const testRepoDir = path.join(os.tmpdir(), testId);
const testArtifactDir = path.join(wfHome, testId, 'jira');
const testFilename = '2026-07-29-abc12345-test-ticket.md';

// repos target must be a sibling of testRepoDir so resolveRepoBasePath can find it
const reposId = `__test-repos-target-${Date.now()}`;
const reposRepoDir = path.join(os.tmpdir(), reposId);
const reposArtifactDir = path.join(wfHome, reposId, 'jira');

function setup() {
  fs.mkdirSync(testRepoDir, { recursive: true });
  fs.mkdirSync(testArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(testArtifactDir, testFilename), TICKET_CONTENT);

  fs.mkdirSync(reposRepoDir, { recursive: true });
  fs.mkdirSync(reposArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(reposArtifactDir, testFilename), TICKET_CONTENT);
}

function cleanup() {
  fs.rmSync(testRepoDir, { recursive: true, force: true });
  fs.rmSync(reposRepoDir, { recursive: true, force: true });
  fs.rmSync(path.join(wfHome, testId), { recursive: true, force: true });
  fs.rmSync(path.join(wfHome, reposId), { recursive: true, force: true });
}

function captureConsole(): { output: string; errors: string; restore: () => void } {
  let output = '';
  let errors = '';
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: string[]) => {
    output += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: string[]) => {
    errors += args.map(String).join(' ') + '\n';
  };
  return {
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

async function main() {
  console.log('\ntest-issue-create-artifact-resolution\n');

  setup();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const command = app.get(IssueCreateCommand);

  const origCwd = process.cwd();

  try {
    // 1. Bare filename resolves to artifact dir, not cwd
    {
      process.chdir(testRepoDir);
      const capture = captureConsole();
      try {
        await command.run([testFilename], { dryRun: true, ticketProject: 'TEST' } as any);
      } finally {
        capture.restore();
      }

      const expectedArtifactPath = path.join(testArtifactDir, testFilename);
      if (capture.output.includes(expectedArtifactPath)) {
        pass('bare filename resolves to artifact dir');
      } else {
        fail('bare filename resolves to artifact dir', `output did not contain ${expectedArtifactPath}`);
      }

      const cwdPath = path.join(testRepoDir, testFilename);
      if (!capture.output.includes(cwdPath)) {
        pass('bare filename does not resolve to cwd');
      } else {
        fail('bare filename does not resolve to cwd', `output contained cwd path ${cwdPath}`);
      }
    }

    // 2. Absolute path passes through unchanged
    {
      process.chdir(testRepoDir);
      const absPath = path.join(testArtifactDir, testFilename);
      const capture = captureConsole();
      try {
        await command.run([absPath], { dryRun: true, ticketProject: 'TEST' } as any);
      } finally {
        capture.restore();
      }

      if (capture.output.includes(absPath)) {
        pass('absolute path passes through unchanged');
      } else {
        fail('absolute path passes through unchanged', `output did not contain ${absPath}`);
      }
    }

    // 3. Missing bare filename error reports artifact path
    {
      process.chdir(testRepoDir);
      const missingFile = 'nonexistent.md';
      const expectedErrorPath = path.join(wfHome, testId, 'jira', missingFile);
      const cwdErrorPath = path.join(testRepoDir, missingFile);

      // ErrorHandler.handle calls process.exit(1) — intercept it
      let exitCalled = false;
      const origExit = process.exit;
      (process as any).exit = (code?: number) => {
        exitCalled = true;
      };

      const capture = captureConsole();
      try {
        await command.run([missingFile], { dryRun: true, silent: true, ticketProject: 'TEST' } as any);
      } finally {
        capture.restore();
        (process as any).exit = origExit;
      }

      if (!exitCalled) {
        fail('missing file triggers process.exit', 'process.exit was not called');
      } else {
        const allOutput = capture.output + capture.errors;
        if (allOutput.includes(expectedErrorPath)) {
          pass('missing file error reports artifact path');
        } else {
          fail('missing file error reports artifact path', `output: ${allOutput.trim()}`);
        }
        if (!allOutput.includes(cwdErrorPath)) {
          pass('missing file error does not report cwd path');
        } else {
          fail('missing file error does not report cwd path');
        }
      }
    }

    // 4. --repos scopes bare filename to specified repo namespace
    {
      process.chdir(testRepoDir);
      const capture = captureConsole();
      try {
        await command.run([testFilename], {
          repos: [reposId],
          dryRun: true,
          ticketProject: 'TEST',
        } as any);
      } finally {
        capture.restore();
      }

      const expectedReposPath = path.join(reposArtifactDir, testFilename);
      if (capture.output.includes(expectedReposPath)) {
        pass('--repos scopes bare filename to specified repo namespace');
      } else {
        fail('--repos scopes bare filename to specified repo namespace', `output did not contain ${expectedReposPath}`);
      }

      const defaultArtifactPath = path.join(testArtifactDir, testFilename);
      if (!capture.output.includes(defaultArtifactPath)) {
        pass('--repos does not use cwd-derived namespace');
      } else {
        fail('--repos does not use cwd-derived namespace', `output contained default path ${defaultArtifactPath}`);
      }
    }
  } finally {
    process.chdir(origCwd);
    await app.close();
    cleanup();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
