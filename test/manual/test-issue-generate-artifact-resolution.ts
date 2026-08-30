/**
 * Manual Test: issue:generate cwd-inferred artifact resolution without --repos
 *
 * Run: nr test:manual -- test-issue-generate-artifact-resolution
 *
 * Verifies:
 *   1. Bare filename resolves to ~/.wf/<basename(cwd)>/<filename>, not <cwd>/<filename>
 *   2. Bare filename does NOT resolve against the code repository directory
 *   3. Absolute path to an existing artifact passes through unchanged
 *   4. Missing bare filename surfaces an actionable error (not a silent skip)
 *   5. Dry-run and execute paths both resolve the artifact successfully
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
const MOCK_AI_RESPONSE = [
  '# MOCK-1: Test artifact resolution',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  '',
  '### Summary',
  'Artifact resolution test.',
  '',
  '#### Technical Details',
  'None',
  '',
  '### Acceptance Criteria',
  '- None',
  '',
  '### Risks & Assumptions',
  '- None',
].join('\n');

const SOURCE_CONTENT = [
  '# Test source artifact',
  '',
  'This file simulates a source artifact stored in ~/.wf/<repo>/.',
].join('\n');

const wfHome = path.join(os.homedir(), '.wf');
const testId = `__test-gen-artifact-${Date.now()}`;
const testRepoDir = path.join(os.tmpdir(), testId);
const testArtifactDir = path.join(wfHome, testId);
const testFilename = '2026-08-11-test-source.md';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(`  \u2713 ${message}`);
  passed++;
};

const fail = (message: string, detail?: string) => {
  const suffix = detail ? '\n    -> ' + detail : '';
  console.error(`  \u2717 ${message}${suffix}`);
  failed++;
};

function setup() {
  fs.mkdirSync(testRepoDir, { recursive: true });
  fs.mkdirSync(testArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(testArtifactDir, testFilename), SOURCE_CONTENT);

  fs.writeFileSync(path.join(testRepoDir, testFilename), 'WRONG: resolved from cwd, not artifact dir');
}

function cleanup() {
  fs.rmSync(testRepoDir, { recursive: true, force: true });
  fs.rmSync(path.join(wfHome, testId), { recursive: true, force: true });
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
  console.log('\ntest-issue-generate-artifact-resolution\n');

  setup();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const command = app.get(IssueGenerateCommand);

  // Stub AI to avoid real API calls — return a canned ticket
  const originalExecute = AiService.prototype.execute;
  (AiService.prototype as any).execute = async () => ({ content: MOCK_AI_RESPONSE });

  const origCwd = process.cwd();

  try {
    {
      process.chdir(testRepoDir);
      const capture = captureConsole();
      try {
        await command.run([testFilename], { dryRun: true });
      } finally {
        capture.restore();
      }

      const expectedArtifactPath = path.join(testArtifactDir, testFilename);
      if (capture.output.includes(expectedArtifactPath)) {
        pass('bare filename resolves to artifact dir');
      } else {
        fail('bare filename resolves to artifact dir', `output did not contain ${expectedArtifactPath}\n      stdout: ${capture.output.trim()}`);
      }
    }

    {
      process.chdir(testRepoDir);
      const capture = captureConsole();
      try {
        await command.run([testFilename], { dryRun: true });
      } finally {
        capture.restore();
      }

      const cwdPath = path.join(testRepoDir, testFilename);
      if (capture.output.includes(cwdPath)) {
        fail('bare filename does not resolve to cwd', `output contained cwd path ${cwdPath}`);
      } else {
        pass('bare filename does not resolve to cwd');
      }
    }

    {
      process.chdir(testRepoDir);
      const absPath = path.join(testArtifactDir, testFilename);
      const capture = captureConsole();
      try {
        await command.run([absPath], { dryRun: true });
      } finally {
        capture.restore();
      }

      if (capture.output.includes(absPath)) {
        pass('absolute path passes through unchanged');
      } else {
        fail('absolute path passes through unchanged', `output did not contain ${absPath}`);
      }
    }

    {
      process.chdir(testRepoDir);
      const missingFile = 'nonexistent-source.md';

      let exitCalled = false;
      const origExit = process.exit;
      (process as any).exit = () => {
        exitCalled = true;
      };

      const capture = captureConsole();
      try {
        await command.run([missingFile], { dryRun: true, silent: true });
      } finally {
        capture.restore();
        (process as any).exit = origExit;
      }

      if (exitCalled) {
        const allOutput = capture.output + capture.errors;
        if (allOutput.includes('--repos') || allOutput.includes('could not be resolved')) {
          pass('missing file error is actionable');
        } else {
          fail('missing file error is actionable', `output: ${allOutput.trim()}`);
        }

        const cwdPath = path.join(testRepoDir, missingFile);
        if (allOutput.includes(cwdPath)) {
          fail('missing file error does not reference cwd path');
        } else {
          pass('missing file error does not reference cwd path');
        }
      } else {
        fail('missing file triggers process.exit', 'process.exit was not called');
      }
    }

    {
      process.chdir(testRepoDir);

      const dryCapture = captureConsole();
      try {
        await command.run([testFilename], { dryRun: true });
      } finally {
        dryCapture.restore();
      }

      const execCapture = captureConsole();
      let execError: Error | null = null;
      try {
        await command.run([testFilename], { silent: false });
      } catch (err) {
        execError = err instanceof Error ? err : new Error(String(err));
      } finally {
        execCapture.restore();
      }

      const expectedPath = path.join(testArtifactDir, testFilename);
      const dryHasPath = dryCapture.output.includes(expectedPath);

      if (execError) {
        fail('execute path resolves artifact without error', `execute threw: ${execError.message}`);
      } else if (dryHasPath) {
        const execFetched = execCapture.output.includes('Fetched');
        if (dryHasPath && execFetched) {
          pass('dry-run and execute both resolve the artifact successfully');
        } else {
          fail(
            'dry-run and execute both resolve the artifact successfully',
            `dry-run has path: ${dryHasPath}, execute fetched: ${execFetched}`,
          );
        }
      } else {
        fail('dry-run resolves artifact path', `dry-run output did not contain ${expectedPath}`);
      }
    }
  } finally {
    process.chdir(origCwd);
    AiService.prototype.execute = originalExecute;
    await app.close();
    cleanup();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
