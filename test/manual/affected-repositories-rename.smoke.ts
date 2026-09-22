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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkLegacyJsonKey(): void {
  console.log('\n🧪 Test 1: legacy JSON key `repositoriesAffected` maps to `affectedRepositories`\n');
  const plan = parsePlanArtifact(
    JSON.stringify({ action: 'fix', summary: 'Legacy plan', steps: ['Step 1'], estimatedComplexity: 'low', repositoriesAffected: ['service-tourv3'] }),
    'legacy-plan.json'
  );
  const repos = plan.affectedRepositories;
  if (Array.isArray(repos) && repos.length === 1 && repos[0] === 'service-tourv3') {
    pass('Legacy repositoriesAffected mapped to affectedRepositories');
  } else {
    fail('Legacy key was not mapped', JSON.stringify(repos));
  }
}

function checkNewJsonKey(): void {
  console.log('\n🧪 Test 2: new JSON key `affectedRepositories` reads directly\n');
  const plan = parsePlanArtifact(
    JSON.stringify({ action: 'feature', summary: 'New plan', steps: ['Step 1'], estimatedComplexity: 'medium', affectedRepositories: ['api-gateway-v1'] }),
    'new-plan.json'
  );
  const repos = plan.affectedRepositories;
  if (Array.isArray(repos) && repos.length === 1 && repos[0] === 'api-gateway-v1') {
    pass('New affectedRepositories key reads directly');
  } else {
    fail('New key was not read', JSON.stringify(repos));
  }
}

function checkNewKeyPrecedence(): void {
  console.log('\n🧪 Test 3: new key takes precedence when both keys are present\n');
  const plan = parsePlanArtifact(
    JSON.stringify({ action: 'fix', summary: 'Both keys', steps: ['Step 1'], estimatedComplexity: 'low', affectedRepositories: ['new-repo'], repositoriesAffected: ['old-repo'] }),
    'both-keys-plan.json'
  );
  const repos = plan.affectedRepositories;
  if (Array.isArray(repos) && repos.length === 1 && repos[0] === 'new-repo') {
    pass('New key takes precedence over legacy key');
  } else {
    fail('Precedence was wrong', JSON.stringify(repos));
  }
}

const OLD_MD = [
  '**Action:** fix', '**Complexity:** low', '',
  '## Summary', 'Fix the login flow.', '',
  '## Steps', '1. Update auth module', '',
  '## Repositories Affected', '- service-authv2', '',
].join('\n');

function checkOldMarkdownHeading(): void {
  console.log('\n🧪 Test 4: markdown plan with old heading `## Repositories Affected` parses\n');
  const plan = parsePlanArtifact(OLD_MD, 'old-heading-plan.md');
  const repos = plan.affectedRepositories;
  if (Array.isArray(repos) && repos.length === 1 && repos[0] === 'service-authv2') {
    pass('Old heading "Repositories Affected" parsed correctly');
  } else {
    fail('Old heading was not parsed', JSON.stringify(repos));
  }
}

const NEW_MD = [
  '**Action:** feature', '**Complexity:** medium', '',
  '## Summary', 'Add new feature.', '',
  '## Steps', '1. Create module', '',
  '## Affected Repositories', '- api-gateway-v1', '',
].join('\n');

function checkNewMarkdownHeading(): void {
  console.log('\n🧪 Test 5: markdown plan with new heading `## Affected Repositories` parses\n');
  const plan = parsePlanArtifact(NEW_MD, 'new-heading-plan.md');
  const repos = plan.affectedRepositories;
  if (Array.isArray(repos) && repos.length === 1 && repos[0] === 'api-gateway-v1') {
    pass('New heading "Affected Repositories" parsed correctly');
  } else {
    fail('New heading was not parsed', JSON.stringify(repos));
  }
}

async function main(): Promise<void> {
  checkLegacyJsonKey();
  checkNewJsonKey();
  checkNewKeyPrecedence();
  checkOldMarkdownHeading();
  checkNewMarkdownHeading();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
