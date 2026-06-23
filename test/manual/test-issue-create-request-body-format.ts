/**
 * Manual Test: issue:create request body format validation
 *
 * Run: nr test:manual -- test-issue-create-request-body-format
 *
 * Exercises the ADF validation script with known-bad and known-good
 * markdown through the full markdownToADF pipeline.
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { JiraService } from '../../src/integrations/jira/jira.service';

interface ValidationResult {
  passed: boolean;
  issues: Array<{ error: string; suggestion: string }>;
}

const createJiraService = (): JiraService =>
  new JiraService(
    {
      get: (key: string) =>
        ({
          'atlassian.baseUrl': 'https://test.atlassian.net',
          'atlassian.email': 'test@example.com',
          'atlassian.apiToken': 'test-token',
          'atlassian.jira.defaultProject': 'WBP',
        })[key],
    } as any,
    { post: () => undefined } as any,
    { warn: () => undefined, success: () => undefined } as any,
    { isPlatformEnabled: () => true } as any
  );

const runValidator = (payload: unknown): ValidationResult => {
  const result = spawnSync('npx', ['ts-node', 'test/manual/test-verify-request-format.ts'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return JSON.parse(result.stdout);
};

function main() {
  console.log('\nManual Test: issue:create request body format validation\n');

  const service = createJiraService();

  // 1. Known-bad: wiki markup leaks — after normalizeMarkdownForADF these should be converted
  {
    const adf = service.markdownToADF(
      '### Summary\n\nThe {{bufferPx}} variable.\n\n{noformat}raw text{noformat}\n\n* First item.\n* Second item.'
    );
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}: known-bad wiki markup through markdownToADF (${result.issues.length} issue(s))`
    );

    if (!result.passed) {
      for (const issue of result.issues) {
        console.log(`    - ${issue.error}`);
      }
    }
  }

  // 2. Known-good: proper markdown
  {
    const adf = service.markdownToADF(
      '### Summary\n\nClean description.\n\n```css\n.a4 { display: block; }\n```\n\n- First item.\n- Second item.'
    );
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    assert(result.passed, `Expected clean markdown to pass validation but got: ${JSON.stringify(result.issues)}`);
    console.log('  PASS: known-good markdown produces valid ADF');
  }

  // 3. Empty description
  {
    const adf = service.markdownToADF('');
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    assert(!result.passed, 'Expected empty description to fail validation');
    assert(
      result.issues.some(i => i.error.includes('no block nodes')),
      `Expected 'no block nodes' issue but got: ${JSON.stringify(result.issues)}`
    );
    console.log('  PASS: empty description correctly rejected');
  }

  // 4. Bare ADF doc (no fields wrapper)
  {
    const adf = service.markdownToADF('### Summary\n\nClean text.');
    const result = runValidator(adf);

    assert(result.passed, `Expected bare ADF doc to pass but got: ${JSON.stringify(result.issues)}`);
    console.log('  PASS: bare ADF doc (no fields wrapper) accepted');
  }

  console.log('\nAll issue:create request body format tests passed.\n');
}

main();
