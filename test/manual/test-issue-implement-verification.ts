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

  console.log(
    '\n🧪 Test 3: retry regenerates only the implicated file\n' +
      '─'.repeat(60),
  );
  {
    const tmpBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-implement-verify-'),
    );
    const repoDir = path.join(tmpBaseDir, 'repo-a');
    const commandsDir = path.join(repoDir, 'src', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'repo-a',
        scripts: {
          'format:write': 'echo format:write',
          'format:check': 'echo format:check',
          'lint:fix': 'echo lint:fix',
          lint: 'echo lint',
          build: 'echo build',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(commandsDir, 'issue-review.command.ts'),
      'export const message = "Criteria file must be a Markdown (.md) file";\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(commandsDir, 'issue-review.command.spec.ts'),
      'expect(message).toContain("Criteria source");\n',
      'utf-8',
    );

    const ticket: TicketArtifact = {
      ticketKey: 'TEST-VERIFY-003',
      content: '# TEST-VERIFY-003: Retry only implicated file\n',
      path: path.join(tmpBaseDir, 'TEST-VERIFY-003.md'),
    };
    const planArtifact: PlanArtifact = {
      action: 'feature',
      path: path.join(tmpBaseDir, 'TEST-VERIFY-003-plan.json'),
      plan: {
        action: 'feature',
        summary: 'Retry only the implicated file',
        steps: ['Update the command and its regression test'],
        estimatedComplexity: 'medium',
        filesAffected: [
          'repo-a/src/commands/issue-review.command.ts',
          'repo-a/src/commands/issue-review.command.spec.ts',
        ],
        repositoriesAffected: ['repo-a'],
        verification: {
          targeted: [
            {
              id: 'issue-review-command-spec',
              run: 'yarn test src/commands/issue-review.command.spec.ts --runInBand',
              policy: 'enforced',
            },
          ],
        },
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

    const generatedFiles: string[] = [];
    const generateContexts: string[] = [];
    let targetedAttempts = 0;

    aiService.narrateImplementationPlan = async () =>
      '## Goal\nRetry only the implicated file.\n\n## Approach\nUse diagnostics to narrow the retry.\n\n## Tasks\n1. repo-a/src/commands/issue-review.command.ts — keep the implementation behavior.\n2. repo-a/src/commands/issue-review.command.spec.ts — align the regression test.';
    aiService.generateFileChange = async (params: {
      filePath: string;
      conversationContext?: string;
    }) => {
      generatedFiles.push(params.filePath);
      generateContexts.push(params.conversationContext ?? '');

      if (params.filePath.endsWith('issue-review.command.ts')) {
        return 'export const message = "Criteria file must be a Markdown (.md) file";\n';
      }

      if (generatedFiles.length === 2) {
        return 'expect(message).toContain("Criteria source");\n';
      }

      return [
        'expect(message).toContain("Criteria file must be a Markdown (.md) file");',
        'expect(message).not.toContain("Criteria source");',
      ].join('\n');
    };
    gitService.getCurrentBranch = async () => 'main';
    gitService.createBranch = async () => {};
    (implementer as any).getAfterImplementConfig = () => ({
      baseMaxAttempts: 3,
      maxProgressExtensions: 2,
      absoluteMaxAttempts: 5,
      fingerprintLineCount: 5,
      requireStateChangeForRetry: true,
      retryOnSameFailure: false,
      scripts: {
        formatWrite: 'npm run format:write',
        formatCheck: 'npm run format:check',
        lintFix: 'npm run lint:fix',
        lint: 'npm run lint',
        build: 'npm run build',
      },
    });
    (implementer as any).runCommand = async (command: string) => {
      if (
        command ===
        'yarn test src/commands/issue-review.command.spec.ts --runInBand'
      ) {
        targetedAttempts += 1;
        if (targetedAttempts === 1) {
          return {
            command,
            exitCode: 1,
            stdout: [
              'FAIL src/commands/issue-review.command.spec.ts',
              'Expected: ObjectContaining {"message": "Criteria file must be a Markdown (.md) file: criteria.txt"}',
              'Received: [Error: Criteria source must be a Markdown file (.md): criteria.txt]',
            ].join('\n'),
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
        generatedFiles.join(' | ') ===
        [
          'src/commands/issue-review.command.ts',
          'src/commands/issue-review.command.spec.ts',
          'src/commands/issue-review.command.spec.ts',
        ].join(' | ')
      ) {
        pass('Retry regenerates only the file implicated by diagnostics');
      } else {
        fail('Retry rewrote an unexpected file set', generatedFiles.join('\n'));
      }

      if (
        generateContexts[2]?.includes(
          'Treat verification diagnostics as evidence of a mismatch',
        ) &&
        generateContexts[2]?.includes(
          'Only update the implicated file(s) for this retry: src/commands/issue-review.command.spec.ts',
        )
      ) {
        pass('Retry guidance scopes the next AI pass to the implicated file');
      } else {
        fail(
          'Retry guidance did not scope the next AI pass correctly',
          generateContexts[2],
        );
      }
    } catch (error) {
      fail('Implicated-file retry scenario did not pass', String(error));
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
