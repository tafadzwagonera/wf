/**
 * Manual Test: issue:implement single-repo verification flow
 *
 * Run: nr test:manual -- test-issue-implement-verification
 *
 * Verifies:
 *   1. Multi-repo plans are rejected with guidance to use issue or per-repo issue:implement
 *   2. Repository verification manifests run in the selected repo and retries carry diagnostics forward
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const implementer = app.get(ImplementerAgent);

  console.log('\n🧪 Test 1: reject multi-repo plans\n' + '─'.repeat(60));
  {
    const ticket: TicketArtifact = {
      ticketKey: 'TEST-VERIFY-001',
      content: '# TEST-VERIFY-001: Reject multi-repo plan\n',
      path: '/tmp/TEST-VERIFY-001.md',
    };
    const planArtifact: PlanArtifact = {
      action: 'feature',
      path: '/tmp/TEST-VERIFY-001-plan.json',
      plan: {
        action: 'feature',
        summary: 'Invalid multi-repo plan',
        steps: ['Touch repo-a and repo-b'],
        estimatedComplexity: 'medium',
        filesAffected: ['repo-a/src/foo.ts', 'repo-b/src/bar.ts'],
        repositoriesAffected: ['repo-a', 'repo-b'],
      },
    };

    try {
      await implementer.execute(ticket, planArtifact, {
        platformName: 'jira',
        repoDir: '/tmp/repo-a',
      });
      fail('Multi-repo plan was not rejected');
    } catch (error) {
      const message = String((error as Error).message);
      if (
        message.includes('issue:implement only verifies a single repository') &&
        message.includes('Use wf issue')
      ) {
        pass('Multi-repo plans are rejected with issue guidance');
      } else {
        fail('Unexpected multi-repo error message', message);
      }
    }
  }

  console.log(
    '\n🧪 Test 2: retry verification until it passes\n' + '─'.repeat(60),
  );
  {
    const tmpBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-implement-verify-'),
    );
    const repoDir = path.join(tmpBaseDir, 'repo-a');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'repo-a',
        scripts: {
          lint: 'echo lint',
          build: 'echo build',
        },
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'verification.policy.json'),
      JSON.stringify({
        version: 1,
        baseline: [
          {
            id: 'lint',
            run: 'npm run lint',
            policy: 'enforced',
          },
          {
            id: 'build',
            run: 'npm run build',
            policy: 'enforced',
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      'export const value = 0;\n',
    );

    const ticket: TicketArtifact = {
      ticketKey: 'TEST-VERIFY-002',
      content: '# TEST-VERIFY-002: Verify retries\n',
      path: path.join(tmpBaseDir, 'TEST-VERIFY-002.md'),
    };
    const planArtifact: PlanArtifact = {
      action: 'feature',
      path: path.join(tmpBaseDir, 'TEST-VERIFY-002-plan.json'),
      plan: {
        action: 'feature',
        summary: 'Retry verification',
        steps: ['Update src/example.ts'],
        estimatedComplexity: 'medium',
        filesAffected: ['repo-a/src/example.ts'],
        repositoriesAffected: ['repo-a'],
      },
    };

    const aiService = (implementer as any).aiService;
    const gitService = (implementer as any).gitService;
    const originalRunCommand = (implementer as any).runCommand.bind(
      implementer,
    );
    const originalAfterImplement = (implementer as any).getAfterImplementConfig;
    const originalNarrate = aiService.narrateImplementationPlan.bind(aiService);
    const originalGenerate = aiService.generateFileChange.bind(aiService);
    const originalCurrentBranch = gitService.getCurrentBranch.bind(gitService);
    const originalCreateBranch = gitService.createBranch.bind(gitService);

    const executedCommands: string[] = [];
    const generateContexts: string[] = [];
    let lintAttempts = 0;

    aiService.narrateImplementationPlan = async () =>
      '## Goal\nManual verification.\n\n## Approach\nRetry when checks fail.\n\n## Tasks\n1. repo-a/src/example.ts — fix diagnostics';
    aiService.generateFileChange = async (params: {
      conversationContext?: string;
    }) => {
      generateContexts.push(params.conversationContext ?? '');
      return `export const value = ${generateContexts.length};\n`;
    };
    gitService.getCurrentBranch = async () => 'main';
    gitService.createBranch = async () => {};
    (implementer as any).getAfterImplementConfig = () => ({
      maxAttempts: 2,
      fingerprintLineCount: 5,
      policyFile: 'verification.policy.json',
      requireStateChangeForRetry: true,
      retryOnSameFailure: false,
      scripts: {},
    });
    (implementer as any).runCommand = async (command: string, cwd?: string) => {
      executedCommands.push(`${cwd ?? ''}:${command}`);
      if (command === 'npm run lint') {
        lintAttempts += 1;
        if (lintAttempts === 1) {
          return {
            command,
            exitCode: 1,
            stdout: 'src/example.ts:1:1 - error TS1005: ; expected',
            stderr: '',
          };
        }
      }

      return {
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    };

    try {
      await implementer.execute(ticket, planArtifact, {
        platformName: 'jira',
        repoDir,
      });

      if (
        executedCommands.some((entry) => entry === `${repoDir}:npm run lint`) &&
        executedCommands.some((entry) => entry === `${repoDir}:npm run build`)
      ) {
        pass('Verification commands run in the selected repo');
      } else {
        fail(
          'Verification commands did not run in the selected repo',
          executedCommands.join('\n'),
        );
      }

      if (
        generateContexts.length === 2 &&
        generateContexts[1].includes('Verification failed on attempt 1')
      ) {
        pass('Retry feeds verification diagnostics into the next AI pass');
      } else {
        fail(
          'Retry diagnostics were not passed back into file generation',
          generateContexts.join('\n---\n'),
        );
      }
    } catch (error) {
      fail('Verification retry scenario did not pass', String(error));
    } finally {
      (implementer as any).getAfterImplementConfig = originalAfterImplement;
      aiService.narrateImplementationPlan = originalNarrate;
      aiService.generateFileChange = originalGenerate;
      gitService.getCurrentBranch = originalCurrentBranch;
      gitService.createBranch = originalCreateBranch;
      (implementer as any).runCommand = originalRunCommand;
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    }
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) console.log('✅ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
