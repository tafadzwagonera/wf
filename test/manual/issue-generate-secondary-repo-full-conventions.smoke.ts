/**
 * Manual smoke test: issue:generate surfaces full conventions for secondary repos
 *
 * Run: yarn test:manual -- issue-generate-secondary-repo-full-conventions.smoke
 *
 * Verifies:
 *   1. A secondary repo with different conventions from the primary produces a full
 *      "Repository conventions (name):" section in the plan prompt.
 *   2. That full section contains the secondary repo's linter tool name.
 *   3. A secondary repo with identical conventions to the primary is now also included
 *      with a full conventions section (previously omitted entirely).
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
  title: 'Conventions Discovery',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Secondary repo conventions smoke test.',
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

const createRepo = (repoRoot: string, linter: 'eslint' | 'biome' | 'none'): void => {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: path.basename(repoRoot),
      version: '1.0.0',
      devDependencies: {
        ...(linter === 'eslint' ? { eslint: '^8.0.0' } : {}),
        ...(linter === 'biome' ? { '@biomejs/biome': '^1.0.0' } : {}),
        typescript: '^5.0.0',
        jest: '^29.0.0',
      },
    }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf-8');
  fs.writeFileSync(path.join(repoRoot, 'ticket.md'), '# Source\n\nSmoke test source.\n', 'utf-8');

  if (linter === 'eslint') {
    fs.writeFileSync(path.join(repoRoot, '.eslintrc.json'), JSON.stringify({ root: true }), 'utf-8');
  }
  if (linter === 'biome') {
    fs.writeFileSync(path.join(repoRoot, 'biome.json'), JSON.stringify({ linter: { enabled: true } }), 'utf-8');
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
  console.log(chalk.bold.cyan('\n🧪 Manual Test: issue:generate secondary repo full conventions\n'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-manual-secondary-conventions-'));
  const primaryRepo = path.join(tempRoot, 'primary-repo');
  const secondaryBiome = path.join(tempRoot, 'secondary-biome');
  const secondaryTwin = path.join(tempRoot, 'secondary-twin');

  createRepo(primaryRepo, 'eslint');
  createRepo(secondaryBiome, 'biome');
  createRepo(secondaryTwin, 'eslint');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const command = app.get(IssueGenerateCommand);

    const differingPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, secondaryBiome]
    );

    if (differingPrompt.includes('Repository conventions (secondary-biome):')) {
      pass('live prompt includes the full conventions section for the secondary repo with a different linter');
    } else {
      fail('live prompt is missing the full conventions section for secondary-biome', differingPrompt.slice(0, 800));
    }

    if (differingPrompt.includes('biome')) {
      pass('live prompt surfaces the biome linter tool inside the secondary-biome conventions section');
    } else {
      fail('live prompt does not mention biome inside the secondary-biome conventions section', differingPrompt.slice(0, 800));
    }

    const identicalPrompt = await capturePrompt(
      command,
      [path.join(primaryRepo, 'ticket.md')],
      [primaryRepo, secondaryTwin]
    );

    if (identicalPrompt.includes('Repository conventions (secondary-twin):')) {
      pass('live prompt includes the full conventions section for the secondary repo with identical conventions');
    } else {
      fail('live prompt is missing the full conventions section for secondary-twin', identicalPrompt.slice(0, 800));
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
