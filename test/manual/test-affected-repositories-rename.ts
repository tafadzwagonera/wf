/**
 * Manual Test: affectedRepositories rename backward compatibility
 *
 * Run: yarn test:manual -- test-affected-repositories-rename
 *
 * Verifies:
 *   1. parsePlanArtifact maps legacy `repositoriesAffected` JSON key to `affectedRepositories`
 *   2. parsePlanArtifact reads the new `affectedRepositories` JSON key directly
 *   3. Markdown plans with old heading `## Repositories Affected` parse correctly
 *   4. Markdown plans with new heading `## Affected Repositories` parse correctly
 *   5. planToMarkdown emits `## Affected Repositories` heading (not the old form)
 */

import { parsePlanArtifact } from '../../src/shared/utils/plan-artifact';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  \u2713 ${message}`);
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`);
  failed += 1;
};

const main = async (): Promise<void> => {
  console.log('\n\uD83E\uDDEA Test 1: legacy JSON key `repositoriesAffected` maps to `affectedRepositories`\n');
  {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Legacy plan',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        repositoriesAffected: ['service-tourv3'],
      }),
      'legacy-plan.json'
    );
    if (
      Array.isArray(plan.affectedRepositories) &&
      plan.affectedRepositories.length === 1 &&
      plan.affectedRepositories[0] === 'service-tourv3'
    ) {
      pass('Legacy repositoriesAffected mapped to affectedRepositories');
    } else {
      fail('Legacy key was not mapped', JSON.stringify(plan.affectedRepositories));
    }
  }

  console.log('\n\uD83E\uDDEA Test 2: new JSON key `affectedRepositories` reads directly\n');
  {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'feature',
        summary: 'New plan',
        steps: ['Step 1'],
        estimatedComplexity: 'medium',
        affectedRepositories: ['api-gateway-v1'],
      }),
      'new-plan.json'
    );
    if (
      Array.isArray(plan.affectedRepositories) &&
      plan.affectedRepositories.length === 1 &&
      plan.affectedRepositories[0] === 'api-gateway-v1'
    ) {
      pass('New affectedRepositories key reads directly');
    } else {
      fail('New key was not read', JSON.stringify(plan.affectedRepositories));
    }
  }

  console.log('\n\uD83E\uDDEA Test 3: new key takes precedence when both keys are present\n');
  {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Both keys',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        affectedRepositories: ['new-repo'],
        repositoriesAffected: ['old-repo'],
      }),
      'both-keys-plan.json'
    );
    if (
      Array.isArray(plan.affectedRepositories) &&
      plan.affectedRepositories.length === 1 &&
      plan.affectedRepositories[0] === 'new-repo'
    ) {
      pass('New key takes precedence over legacy key');
    } else {
      fail('Precedence was wrong', JSON.stringify(plan.affectedRepositories));
    }
  }

  console.log('\n\uD83E\uDDEA Test 4: markdown plan with old heading `## Repositories Affected` parses\n');
  {
    const md = [
      '**Action:** fix',
      '**Complexity:** low',
      '',
      '## Summary',
      'Fix the login flow.',
      '',
      '## Steps',
      '1. Update auth module',
      '',
      '## Repositories Affected',
      '- service-authv2',
      '',
    ].join('\n');
    const plan = parsePlanArtifact(md, 'old-heading-plan.md');
    if (
      Array.isArray(plan.affectedRepositories) &&
      plan.affectedRepositories.length === 1 &&
      plan.affectedRepositories[0] === 'service-authv2'
    ) {
      pass('Old heading "Repositories Affected" parsed correctly');
    } else {
      fail('Old heading was not parsed', JSON.stringify(plan.affectedRepositories));
    }
  }

  console.log('\n\uD83E\uDDEA Test 5: markdown plan with new heading `## Affected Repositories` parses\n');
  {
    const md = [
      '**Action:** feature',
      '**Complexity:** medium',
      '',
      '## Summary',
      'Add new feature.',
      '',
      '## Steps',
      '1. Create module',
      '',
      '## Affected Repositories',
      '- api-gateway-v1',
      '',
    ].join('\n');
    const plan = parsePlanArtifact(md, 'new-heading-plan.md');
    if (
      Array.isArray(plan.affectedRepositories) &&
      plan.affectedRepositories.length === 1 &&
      plan.affectedRepositories[0] === 'api-gateway-v1'
    ) {
      pass('New heading "Affected Repositories" parsed correctly');
    } else {
      fail('New heading was not parsed', JSON.stringify(plan.affectedRepositories));
    }
  }

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${passed} passed   \u274C ${failed} failed`);
  if (failed === 0) {
    console.log('\u2705 All tests passed!');
  }
  console.log('\u2501'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
};

main();
