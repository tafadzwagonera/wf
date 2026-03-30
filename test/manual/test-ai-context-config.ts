import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadAiContextConfig } from '../../src/integrations/ai/adapters/load-ai-context-config';

const projectConfigPath = path.join(process.cwd(), 'CLAUDE.md');
const globalConfigPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');

async function main() {
  console.log(chalk.bold.cyan('=== AI Context Config Test ===\n'));

  // --- Scenario 1: both configs present ---
  console.log(chalk.cyan('Scenario 1: both global and project config exist'));
  await fs.writeFile(projectConfigPath, 'Project-level test rule\n');

  const bothResult = await loadAiContextConfig(
    globalConfigPath,
    'CLAUDE.md',
    'anthropic',
  );
  console.log('Result:\n', bothResult || '(empty)');

  // --- Scenario 2: only project config ---
  console.log(chalk.cyan('\nScenario 2: only project config exists'));
  const projectOnlyResult = await loadAiContextConfig(
    path.join(os.homedir(), '.claude', 'DOES_NOT_EXIST.md'),
    'CLAUDE.md',
    'anthropic',
  );
  console.log('Result:\n', projectOnlyResult || '(empty)');

  // --- Scenario 3: neither config exists ---
  console.log(chalk.cyan('\nScenario 3: no config exists (expect chalk.yellow warning)'));
  const noneResult = await loadAiContextConfig(
    path.join(os.homedir(), '.claude', 'DOES_NOT_EXIST.md'),
    'DOES_NOT_EXIST.md',
    'anthropic',
  );
  console.log('Result:', noneResult || '(empty — warning should appear above)');

  // --- Scenario 4: DeepSeek (null global path) ---
  console.log(chalk.cyan('\nScenario 4: DeepSeek (null global, project DEEPSEEK.md missing)'));
  const deepseekResult = await loadAiContextConfig(null, 'DEEPSEEK.md', 'deepseek');
  console.log('Result:', deepseekResult || '(empty — warning should appear above)');

  // Cleanup
  await fs.unlink(projectConfigPath).catch(() => {});

  console.log(chalk.bold.cyan('\n=== Test Complete ==='));
}

main().catch((err) => {
  console.error(chalk.yellow(`⚠️ Test failed: ${err.message}`));
  process.exit(1);
});
