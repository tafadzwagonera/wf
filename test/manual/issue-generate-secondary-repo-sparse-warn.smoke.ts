/**
 * Manual smoke test: issue:generate excludes sparse secondary repo and emits WARN log
 *
 * Run: yarn test:manual -- issue-generate-secondary-repo-sparse-warn.smoke
 *
 * Verifies:
 *   1. A secondary repo with no meaningful conventions and no deltas from the primary is
 *      excluded from the plan prompt's cross-repo section.
 *   2. appendToLogFile emits a WARN entry naming the excluded repo to the on-disk log file.
 *   3. When a meaningful secondary repo is present alongside the sparse one, the meaningful
 *      repo appears with a full conventions section while the sparse repo remains absent.
 *   4. The live command does not need a real AI provider because the manual smoke test
 *      patches the stage backends.
 */

import { NestFactory } from '@nestjs/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { createReporter } from './support/reporter';

const mockTicket = JSON.stringify({
  title: 'Sparse Repo Guard',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Sparse secondary repo smoke test.',
    '',
    '#### Technical Details',
    'None',
    '',
    '### Acceptance Criteria',
    '- None',
    '',
    '### Risks & Assumptions',
    '- None',
    '',
    '#### Out of Scope',
    '- None',
  ].join('\n'),
});

const { counts, pass, fail } = createReporter();

const createSparseRepo = (repoRoot: string): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: path.basename(repoRoot), version: '1.0.0' }, null, 2),
    'utf-8'
  );
};

const createMeaningfulRepo = (repoRoot: string): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: path.basename(repoRoot),
      version: '1.0.0',
      devDependencies: { eslint: '^8.0.0', typescript: '^5.0.0', jest: '^29.0.0' },
    }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf-8');
  fs.writeFileSync(path.join(repoRoot, '.eslintrc.json'), JSON.stringify({ root: true }), 'utf-8');
};

const capturePrompt = async (command: IssueGenerateCommand, args: string[], repos: string[]): Promise<string> => {
  const originalExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  let capturedPrompt = '';

  const aiPrototype = AiService.prototype as unknown as {
    execute: typeof AiService.prototype.execute;
  };
  aiPrototype.execute = async (request: { prompt?: string }) => {
    capturedPrompt = request.prompt ?? '';
    return { content: mockTicket };
  };

  const stageAgentPrototype = StageAgentService.prototype as unknown as {
    generateFromPrompt: typeof StageAgentService.prototype.generateFromPrompt;
  };
  stageAgentPrototype.generateFromPrompt = async (prompt: string) => {
    capturedPrompt = prompt;
    return { content: mockTicket };
  };

  try {
    await command.run(args, { repos, silent: true });
  } finally {
    AiService.prototype.execute = originalExecute;
    StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;
  }

  return capturedPrompt;
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Manual Test: issue:generate sparse secondary repo excluded with WARN\n'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-sparse-secondary-'));
  const primaryRepo = path.join(tempRoot, 'primary-repo');
  const sparseRepo = path.join(tempRoot, 'sparse-repo');
  const meaningfulRepo = path.join(tempRoot, 'meaningful-repo');

  createSparseRepo(primaryRepo);
  fs.writeFileSync(path.join(primaryRepo, 'ticket.md'), '# Source\n\nSmoke test source.\n', 'utf-8');
  createSparseRepo(sparseRepo);
  createMeaningfulRepo(meaningfulRepo);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const command = app.get(IssueGenerateCommand);

    const logDate = new Date().toISOString().split('T')[0];
    const logFile = path.join(os.homedir(), '.wf', 'logs', `agent-${logDate}.log`);
    const logContentBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';

    const sparseOnlyPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, sparseRepo]
    );

    if (sparseOnlyPrompt.includes('Repository conventions (sparse-repo):')) {
      fail('sparse-repo incorrectly appears in the cross-repo conventions section');
    } else {
      pass('sparse-repo is correctly excluded from the cross-repo conventions section');
    }

    if (sparseOnlyPrompt.includes('Patterns from related repositories:')) {
      fail('cross-repo section header appears when all secondary repos are sparse');
    } else {
      pass('cross-repo section header is absent when all secondary repos are sparse');
    }

    const logContentAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
    const newLogContent = logContentAfter.slice(logContentBefore.length);

    if (newLogContent.includes('sparse-repo')) {
      pass('WARN log entry names the excluded sparse-repo');
    } else {
      fail('WARN log entry naming sparse-repo was not found', `checked: ${logFile}`);
    }

    const mixedPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, sparseRepo, meaningfulRepo]
    );

    if (mixedPrompt.includes('Repository conventions (meaningful-repo):')) {
      pass('live prompt includes the full conventions section for meaningful-repo alongside sparse-repo');
    } else {
      fail('live prompt is missing the full conventions section for meaningful-repo', mixedPrompt.slice(0, 800));
    }

    if (mixedPrompt.includes('Repository conventions (sparse-repo):')) {
      fail('sparse-repo still incorrectly appears when a meaningful secondary is present');
    } else {
      pass('sparse-repo remains absent when a meaningful secondary is present');
    }
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold.cyan(`\n  Results: ${counts.passed} passed, ${counts.failed} failed\n`));

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
