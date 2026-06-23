/**
 * Manual smoke test: Plan context forwarding to implementation prompt
 *
 * Run: nr test:manual -- test-plan-context-forwarding
 *
 * Verifies:
 *   1. buildSystemPrompt includes "Plan summary:" section
 *   2. buildSystemPrompt renders provided planSummary text
 *   3. buildSystemPrompt includes bug-fix action preamble for action='fix'
 *   4. buildSystemPrompt includes feature action preamble for action='feature'
 *   5. buildSystemPrompt defaults action to "(not specified)" when omitted
 *   6. buildSystemPrompt includes "Risks and guardrails:" section
 *   7. buildSystemPrompt renders numbered risk items
 *   8. buildSystemPrompt defaults risks to "(none identified)" when empty
 *   9. buildSystemPrompt uses "Ticket context:" label (not "Task context:")
 *  10. buildSystemPrompt renders ticketContext content
 *  11. Narration removed from implementer agent source
 *  12. Narration removed from config types
 *  13. Plan prompt enrichment includes code snippet guidance
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
    console.log(chalk.green(`  PASS: ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  FAIL: ${label}`));
    failed++;
  }
};

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: Plan context forwarding to implementation\n'));

  const srcRoot = path.join(__dirname, '..', '..', 'src');

  const anthropicAdapterSource = fs.readFileSync(
    path.join(srcRoot, 'integrations', 'ai', 'adapters', 'anthropic-agent.adapter.ts'),
    'utf8'
  );

  const openaiAdapterSource = fs.readFileSync(
    path.join(srcRoot, 'integrations', 'ai', 'adapters', 'openai-agent.adapter.ts'),
    'utf8'
  );

  const implementerSource = fs.readFileSync(path.join(srcRoot, 'agents', 'implementer.agent.ts'), 'utf8');

  const publicConfigSource = fs.readFileSync(path.join(srcRoot, 'config', 'public-config.ts'), 'utf8');

  const aiServiceSource = fs.readFileSync(path.join(srcRoot, 'integrations', 'ai', 'ai.service.ts'), 'utf8');

  const stageAgentSource = fs.readFileSync(path.join(srcRoot, 'integrations', 'ai', 'stage-agent.service.ts'), 'utf8');

  // --- Plan summary in prompt ---

  // 1. buildSystemPrompt includes "Plan summary:" section
  assert(
    'Anthropic buildSystemPrompt includes "Plan summary:" section',
    anthropicAdapterSource.includes('Plan summary:')
  );

  // 2. buildSystemPrompt renders provided planSummary text
  assert(
    'Anthropic buildSystemPrompt accepts planSummary parameter',
    anthropicAdapterSource.includes('planSummary?: string')
  );

  // --- Action preamble ---

  // 3. Bug-fix action preamble
  assert(
    'Anthropic buildSystemPrompt includes bug-fix action preamble',
    anthropicAdapterSource.includes('This is a bug fix. Make minimal, targeted changes')
  );

  // 4. Feature action preamble
  assert(
    'Anthropic buildSystemPrompt includes feature action preamble',
    anthropicAdapterSource.includes('This is a new feature. Extend the codebase following existing patterns')
  );

  // 5. Default action fallback
  assert(
    'Anthropic buildSystemPrompt defaults action to "(not specified)"',
    anthropicAdapterSource.includes("return '(not specified)'")
  );

  // --- Risks and guardrails ---

  // 6. Risks section present
  assert(
    'Anthropic buildSystemPrompt includes "Risks and guardrails:" section',
    anthropicAdapterSource.includes('Risks and guardrails:')
  );

  // 7. planRisks parameter accepted
  assert(
    'Anthropic buildSystemPrompt accepts planRisks parameter',
    anthropicAdapterSource.includes('planRisks?: string[]')
  );

  // 8. Default risks fallback
  assert(
    'Anthropic buildSystemPrompt defaults risks to "(none identified)"',
    anthropicAdapterSource.includes('(none identified)')
  );

  // --- Ticket context label ---

  // 9. Uses "Ticket context:" not "Task context:"
  assert(
    'Anthropic buildSystemPrompt uses "Ticket context:" label',
    anthropicAdapterSource.includes('Ticket context:') && !anthropicAdapterSource.includes('Task context:')
  );

  // 10. ticketContext parameter (not sceneContext)
  assert(
    'Anthropic buildSystemPrompt uses ticketContext parameter',
    anthropicAdapterSource.includes('ticketContext: string') && !anthropicAdapterSource.includes('sceneContext')
  );

  // --- OpenAI parity ---

  assert('OpenAI buildSystemPrompt includes "Plan summary:" section', openaiAdapterSource.includes('Plan summary:'));

  assert(
    'OpenAI buildSystemPrompt includes "Risks and guardrails:" section',
    openaiAdapterSource.includes('Risks and guardrails:')
  );

  assert(
    'OpenAI buildSystemPrompt uses "Ticket context:" label',
    openaiAdapterSource.includes('Ticket context:') && !openaiAdapterSource.includes('Task context:')
  );

  // --- Narration removed ---

  // 11. Narration removed from implementer agent
  assert(
    'Narration removed from implementer agent source',
    !implementerSource.includes('narrateImplementationPlan') && !implementerSource.includes('shouldNarrate')
  );

  // 12. Narration removed from config types
  assert('Narration removed from config types', !publicConfigSource.includes('narrate'));

  // --- Plan prompt enrichment ---

  // 13. Code snippet guidance in plan prompts
  assert(
    'ai.service plan prompt includes code snippet guidance',
    aiServiceSource.includes('embed relevant snippets inline')
  );

  assert(
    'stage-agent.service plan prompt includes code snippet guidance',
    stageAgentSource.includes('embed relevant snippets inline')
  );

  // --- planSummary/planRisks/planAction threaded at call sites ---

  assert(
    'Anthropic adapter threads planSummary at call site',
    anthropicAdapterSource.includes('planSummary: params.planArtifact.plan.summary')
  );

  assert(
    'Anthropic adapter threads planRisks at call site',
    anthropicAdapterSource.includes('planRisks: params.planArtifact.plan.risks')
  );

  assert(
    'Anthropic adapter threads planAction at call site',
    anthropicAdapterSource.includes('planAction: params.planArtifact.plan.action')
  );

  assert(
    'OpenAI adapter threads planSummary at call site',
    openaiAdapterSource.includes('planSummary: params.planArtifact.plan.summary')
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

void run();
