/**
 * Manual Test: issue:implement custom fix/feature plan execution
 *
 * Run: yarn test:manual -- test-issue-implement-custom-plan
 *
 * Verifies:
 *   1. Custom fix plans synthesize execution context and call the shared implementer flow
 *   2. Custom feature dry-runs preview branch and file work
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(`  ✓ ${message}`);
  passed++;
};

const fail = (message: string, detail?: string) => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

const captureStdout = (): { restore: () => string } => {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    output += String(chunk);
    return true;
  };

  return {
    restore: () => {
      process.stdout.write = originalWrite;
      return output;
    },
  };
};

const overrideHomeDir = (nextHomeDir: string): (() => void) => {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;

  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }

    process.env.HOME = previousHome;
  };
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueImplementCommand);
  const implementer = (command as any).orchestrator.implementer as {
    execute: (ticket: TicketArtifact, planArtifact: PlanArtifact, options: ImplementerOptions) => Promise<unknown>;
  };

  console.log('\n🧪 Test 1: custom fix plan uses synthetic execution context\n' + '─'.repeat(60));
  {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-implement-'));
    const appDir = path.join(tmpBaseDir, 'app');
    const repoDir = path.join(tmpBaseDir, 'repo-a');
    const customArtifactDir = path.join(tmpBaseDir, '.wf', 'repo-a');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(customArtifactDir, { recursive: true });
    const planPath = path.join(customArtifactDir, 'dark-building-creek-fix.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        action: 'fix',
        summary: 'Repair the custom implementation path',
        steps: ['Route custom plans to the shared implementer'],
        estimatedComplexity: 'medium',
        affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'],
        affectedRepositories: ['repo-a'],
      }),
      'utf-8'
    );

    const restoreHome = overrideHomeDir(tmpBaseDir);
    const originalCwd = process.cwd.bind(process);
    const stdoutCapture = captureStdout();
    let capturedTicket: TicketArtifact | undefined;
    let capturedPlanArtifact: PlanArtifact | undefined;
    let capturedOptions: ImplementerOptions | undefined;
    const originalExecute = implementer.execute.bind(implementer);

    (process as any).cwd = () => appDir;
    implementer.execute = async (ticket: TicketArtifact, planArtifact: PlanArtifact, options: ImplementerOptions) => {
      capturedTicket = ticket;
      capturedPlanArtifact = planArtifact;
      capturedOptions = options;
      return {
        type: 'implementation',
        branchName: 'bugfix/dark-building-creek',
      };
    };

    try {
      await command.run(['dark-building-creek-fix.json'], {
        repos: ['repo-a'],
      });
      const output = stdoutCapture.restore();

      if (capturedTicket?.ticketKey === 'dark-building-creek') {
        pass('Synthetic ticket key strips the trailing action from the artifact stem');
      } else {
        fail('Synthetic ticket key did not match the expected artifact stem', JSON.stringify(capturedTicket, null, 2));
      }

      if (capturedOptions?.customBranchSlug === 'dark-building-creek') {
        pass('Custom branch slug is forwarded to the implementer');
      } else {
        fail('Custom branch slug was not forwarded to the implementer', JSON.stringify(capturedOptions, null, 2));
      }

      if (capturedPlanArtifact?.path === planPath && capturedPlanArtifact.action === 'fix') {
        pass('Custom fix plan artifact is passed through unchanged');
      } else {
        fail('Custom fix plan artifact was not forwarded correctly', JSON.stringify(capturedPlanArtifact, null, 2));
      }

      if (output.includes('synthetic execution context')) {
        pass('Command warns when it creates a synthetic execution context');
      } else {
        fail('Command output did not include the synthetic execution context warning');
      }
    } finally {
      stdoutCapture.restore();
      implementer.execute = originalExecute;
      (process as any).cwd = originalCwd;
      restoreHome();
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    }
  }

  console.log('\n🧪 Test 2: custom feature dry-run previews branch and file work\n' + '─'.repeat(60));
  {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-implement-'));
    const appDir = path.join(tmpBaseDir, 'app');
    const repoDir = path.join(tmpBaseDir, 'repo-a');
    const customArtifactDir = path.join(tmpBaseDir, '.wf', 'repo-a');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src', 'commands'), { recursive: true });
    fs.mkdirSync(customArtifactDir, { recursive: true });
    const trackedFile = path.join(repoDir, 'src', 'commands', 'issue-implement.command.ts');
    fs.writeFileSync(trackedFile, '// existing file\n', 'utf-8');
    const planPath = path.join(customArtifactDir, 'dark-building-creek-feature.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        action: 'feature',
        summary: 'Implement the custom plan flow',
        steps: ['Preview branch and file work'],
        estimatedComplexity: 'medium',
        affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'],
        affectedRepositories: ['repo-a'],
      }),
      'utf-8'
    );

    const restoreHome = overrideHomeDir(tmpBaseDir);
    const originalCwd = process.cwd.bind(process);
    const stdoutCapture = captureStdout();

    (process as any).cwd = () => appDir;

    try {
      await command.run(['dark-building-creek-feature.json'], {
        repos: ['repo-a'],
        dryRun: true,
      });
      const output = stdoutCapture.restore();

      if (output.includes('git branch')) {
        pass('Dry-run previews branch work for custom feature plans');
      } else {
        fail('Dry-run output did not preview branch work', output);
      }

      if (output.includes('feature/dark-building-creek')) {
        pass('Dry-run previews the artifact-derived custom branch name');
      } else {
        fail('Dry-run output did not include the expected custom branch name', output);
      }

      if (output.includes(trackedFile)) {
        pass('Dry-run previews the repo-local file write target');
      } else {
        fail('Dry-run output did not include the expected file write target', output);
      }
    } finally {
      stdoutCapture.restore();
      (process as any).cwd = originalCwd;
      restoreHome();
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    }
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${passed} passed   ✗ ${failed} failed`);
  if (failed === 0) console.log('✓ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
