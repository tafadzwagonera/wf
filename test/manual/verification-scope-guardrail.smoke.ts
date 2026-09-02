/**
 * Manual smoke test: verification fix-pass scope guardrail constrains AI to planned files
 *
 * Run: nr test:manual -- verification-scope-guardrail
 *
 * Scenario: `buildVerificationFixPrompt` now accepts an optional `scopedFiles?: string[]`
 * param. When non-empty, the assembled prompt includes a scope-constraint note. This test
 * verifies prompt construction at the live function level without spawning an AI session.
 */
import chalk from 'chalk';
import { buildVerificationFixPrompt } from '../../src/integrations/ai/adapters/verification-report';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const failure = {
  id: 'f1',
  command: 'yarn test',
  policy: 'enforced' as const,
  status: 'failed' as const,
  output: 'TypeError: cannot read property x',
};

function main(): void {
  console.log(chalk.bold('\nVerification scope guardrail smoke test\n'));

  const basePrompt = buildVerificationFixPrompt([failure]);
  const scopeNote = 'Only modify files within this task\'s scope';

  assert(
    'no scopedFiles — scope note is absent from prompt',
    !basePrompt.includes(scopeNote),
    `prompt unexpectedly contained scope note`,
  );

  assert(
    'no scopedFiles — base prompt contains fix instruction',
    basePrompt.includes('fix the code so all listed commands pass'),
    `base prompt missing fix instruction`,
  );

  const scopedPrompt = buildVerificationFixPrompt([failure], ['src/foo.ts', 'src/bar.ts']);

  assert(
    'non-empty scopedFiles — scope note is present',
    scopedPrompt.includes(scopeNote),
    `scope note missing from prompt`,
  );

  assert(
    'non-empty scopedFiles — listed files appear in prompt',
    scopedPrompt.includes('src/foo.ts') && scopedPrompt.includes('src/bar.ts'),
    `one or both file paths missing`,
  );

  assert(
    'non-empty scopedFiles — blocker-reporting instruction is present',
    scopedPrompt.includes('pre-existing issue unrelated to this task'),
    `blocker-reporting instruction missing`,
  );

  const separatorIndex = scopedPrompt.indexOf('to work around it.');
  const afterScopeNote = scopedPrompt.slice(separatorIndex + 'to work around it.'.length);
  assert(
    'scope note ends with \\n\\n separator before final instruction',
    afterScopeNote.startsWith('\n\nDo not re-run'),
    `got: ${JSON.stringify(afterScopeNote.slice(0, 40))}`,
  );

  const emptyScoped = buildVerificationFixPrompt([failure], []);
  assert(
    'empty scopedFiles array — prompt is identical to the no-scopedFiles prompt',
    emptyScoped === basePrompt,
    `prompts differ; scope note may have been appended for empty array`,
  );

  const emptyFailures = buildVerificationFixPrompt([], ['src/foo.ts']);
  assert(
    'empty failures with scopedFiles — returns empty string',
    emptyFailures === '',
    `got: ${JSON.stringify(emptyFailures)}`,
  );

  const total = counts.passed + counts.failed;
  console.log(
    chalk.bold(
      `\n${total} assertions: ${chalk.green(`${counts.passed} passed`)}`
      + (counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : ''),
    ),
  );
  if (counts.failed > 0) process.exit(1);
}

main();
