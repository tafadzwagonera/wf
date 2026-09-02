/**
 * Manual smoke test: issue:generate cross-repo git-hooks discovery
 *
 * Run: yarn test:manual test-issue-generate-cross-repo-git-hooks
 *
 * Verifies:
 *   1. The live issue:generate prompt includes repo conventions for the primary repo.
 *   2. The prompt renders git hook bullets for a real lefthook config.
 *   3. The prompt includes a cross-repo delta when the secondary repo uses a different git-hooks tool.
 *   4. The prompt includes a cross-repo delta when the secondary repo has no git hooks.
 *   5. The live command does not need a real AI provider because the manual smoke test patches the stage backends.
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

const MOCK_TICKET = JSON.stringify({
  title: 'Hook Discovery',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Hook discovery smoke test.',
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

const createRepo = (repoRoot: string, gitHookTool: 'lefthook' | 'husky' | 'none'): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: path.basename(repoRoot), version: '1.0.0' }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(path.join(repoRoot, 'ticket.md'), '# Source\n\nSmoke test source.\n', 'utf-8');

  if (gitHookTool === 'lefthook') {
    fs.writeFileSync(
      path.join(repoRoot, 'lefthook.yml'),
      [
        'pre-commit:',
        '  commands:',
        '    lint:',
        '      run: yarn lint',
        '    typecheck:',
        '      run: yarn typecheck',
        '',
      ].join('\n'),
      'utf-8'
    );
    return;
  }

  if (gitHookTool === 'husky') {
    const huskyDir = path.join(repoRoot, '.husky');
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(path.join(huskyDir, 'pre-commit'), '#!/usr/bin/env sh\nyarn lint\n', 'utf-8');
  }
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
    return { content: MOCK_TICKET };
  };

  const stageAgentPrototype = StageAgentService.prototype as unknown as {
    generateFromPrompt: typeof StageAgentService.prototype.generateFromPrompt;
  };
  stageAgentPrototype.generateFromPrompt = async (prompt: string) => {
    capturedPrompt = prompt;
    return { content: MOCK_TICKET };
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
  console.log(chalk.bold.cyan('\n🧪 Manual Test: issue:generate cross-repo git-hooks discovery\n'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-cross-repo-git-hooks-'));
  const primaryRepo = path.join(tempRoot, 'primary-repo');
  const secondaryRepoWithDifferentTool = path.join(tempRoot, 'secondary-husky');
  const secondaryRepoWithoutHooks = path.join(tempRoot, 'secondary-empty');

  createRepo(primaryRepo, 'lefthook');
  createRepo(secondaryRepoWithDifferentTool, 'husky');
  createRepo(secondaryRepoWithoutHooks, 'none');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const command = app.get(IssueGenerateCommand);

    const differingToolsPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, secondaryRepoWithDifferentTool]
    );

    if (differingToolsPrompt.includes('Git hooks (lefthook):')) {
      pass('live prompt includes the primary repo git-hooks section');
    } else {
      fail('live prompt is missing the primary repo git-hooks section', differingToolsPrompt.slice(0, 800));
    }

    if (differingToolsPrompt.includes('  - pre-commit: yarn lint, yarn typecheck')) {
      pass('live prompt renders nested hook bullets for lefthook');
    } else {
      fail('live prompt does not render nested lefthook bullets', differingToolsPrompt.slice(0, 800));
    }

    if (differingToolsPrompt.includes('secondary-husky uses husky git hooks (primary uses lefthook)')) {
      pass('live prompt includes the cross-repo git-hooks delta for a different tool');
    } else {
      fail('live prompt is missing the cross-repo git-hooks delta for a different tool', differingToolsPrompt.slice(0, 800));
    }

    const missingHooksPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, secondaryRepoWithoutHooks]
    );

    if (missingHooksPrompt.includes('secondary-empty has no git hooks (primary uses lefthook)')) {
      pass('live prompt includes the cross-repo delta when the secondary repo has no hooks');
    } else {
      fail('live prompt is missing the cross-repo no-hooks delta', missingHooksPrompt.slice(0, 800));
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
