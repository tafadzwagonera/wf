/**
 * Manual smoke test: models.default config key rename
 *
 * Run: nr test:manual -- test-models-default-config-key
 *
 * Verifies:
 *   1. WfImplementStageModelsConfig uses `default` (not `primary`) as the key.
 *   2. Joi schema accepts `models.default` in implementStageSchema.
 *   3. shared-routing reads `modelsConfig?.default` for the default model.
 *   4. shared-routing param is `fallbackDefaultModel` (not `fallbackPrimaryModel`).
 *   5. Both adapters pass `fallbackDefaultModel` to resolveModelRouting.
 *   6. Log output uses `default=` label (not `primary=`).
 *   7. README documents `stages.implement.models.default`.
 *   8. ModelRouting type uses `default` (not `primary`) as a routing strategy.
 *   9. ModelRoutingResult uses `defaultModel` (not `primaryModel`).
 *  10. CLI help text uses `default` for the model routing option.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

const srcRoot = path.join(__dirname, '..', '..', 'src');
const adaptersDir = path.join(srcRoot, 'integrations', 'ai', 'adapters');

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: models.default config key rename\n'));

  const publicConfigSource = fs.readFileSync(path.join(srcRoot, 'config', 'public-config.ts'), 'utf8');
  const configLoaderSource = fs.readFileSync(path.join(srcRoot, 'config', 'wf-config-loader.ts'), 'utf8');
  const sharedSource = fs.readFileSync(path.join(adaptersDir, 'shared-routing.ts'), 'utf8');
  const openaiSource = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');
  const anthropicSource = fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8');
  const readmeSource = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

  // --- 1. Type uses `default`, not `primary` ---

  assert(
    'WfImplementStageModelsConfig has `default` key',
    publicConfigSource.includes('default?: string') && !publicConfigSource.includes('primary?: string')
  );

  // --- 2. Joi schema accepts `models.default` ---

  assert(
    'Joi schema includes default: Joi.string()',
    /models:\s*Joi\.object\(\{[^}]*default:\s*Joi\.string\(\)/.test(configLoaderSource)
  );

  // --- 3. shared-routing reads `modelsConfig?.default` ---

  assert('shared-routing reads modelsConfig?.default', sharedSource.includes('modelsConfig?.default'));
  assert('shared-routing does NOT read modelsConfig?.primary', !sharedSource.includes('modelsConfig?.primary'));

  // --- 4. Param is `fallbackDefaultModel` ---

  assert('shared-routing param is fallbackDefaultModel', sharedSource.includes('fallbackDefaultModel: string'));
  assert('shared-routing does NOT use fallbackPrimaryModel', !sharedSource.includes('fallbackPrimaryModel'));

  // --- 5. Both adapters pass `fallbackDefaultModel` ---

  assert('OpenAI adapter uses fallbackDefaultModel', openaiSource.includes('fallbackDefaultModel'));
  assert('OpenAI adapter does NOT use fallbackPrimaryModel', !openaiSource.includes('fallbackPrimaryModel'));
  assert('Anthropic adapter uses fallbackDefaultModel', anthropicSource.includes('fallbackDefaultModel'));
  assert('Anthropic adapter does NOT use fallbackPrimaryModel', !anthropicSource.includes('fallbackPrimaryModel'));

  // --- 6. Log output uses `default=` label ---

  assert('shared-routing log uses default= label', sharedSource.includes('default=${defaultModel}'));
  assert('shared-routing log does NOT use primary= variable in log', !sharedSource.includes('default=${primaryModel}'));

  // --- 7. README documents models.default ---

  assert('README YAML example uses default: key', readmeSource.includes('      default: gpt-4.1'));
  assert(
    'README prose uses stages.implement.models.default',
    readmeSource.includes('`stages.implement.models.default`')
  );
  assert(
    'README does NOT reference stages.implement.models.primary',
    !readmeSource.includes('`stages.implement.models.primary`')
  );

  // --- 8. ModelRouting type uses `default` routing strategy ---

  const interfacesSource = fs.readFileSync(path.join(srcRoot, 'agents', 'interfaces.ts'), 'utf8');
  assert('ModelRouting includes default strategy', interfacesSource.includes('\'auto\' | \'default\' | \'mechanical\''));
  assert(
    'ModelRouting does NOT include primary strategy',
    !interfacesSource.includes('\'auto\' | \'primary\' | \'mechanical\'')
  );

  // --- 9. ModelRoutingResult uses `defaultModel` ---

  assert('ModelRoutingResult has defaultModel field', sharedSource.includes('defaultModel: string'));
  assert(
    'ModelRoutingResult does NOT have primaryModel field',
    !sharedSource.includes('primaryModel: string') && !sharedSource.includes('primaryModel,')
  );

  // --- 10. CLI help text uses `default` ---

  const issueCommandSource = fs.readFileSync(path.join(srcRoot, 'commands', 'issue.command.ts'), 'utf8');
  const issueImplementSource = fs.readFileSync(path.join(srcRoot, 'commands', 'issue-implement.command.ts'), 'utf8');
  assert('issue.command help text uses default routing', issueCommandSource.includes('default (force default model)'));
  assert(
    'issue-implement.command help text uses default routing',
    issueImplementSource.includes('default (force default model)')
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
