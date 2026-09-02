/**
 * Manual smoke test: commit policy log line prints allowed/blocked, no complexity or arrow
 *
 * ImplementerAgent.buildConventionsSection used to log
 * `Commit policy: ${complexity} -> ${'commits allowed'|'commits blocked'}`
 * (e.g. "Commit policy: medium -> commits blocked"). It now logs the simplified
 * `Commit policy: ${'allowed'|'blocked'}` form. This verifies a real call to
 * buildConventionsSection prints the new wording for every complexity tier, and
 * that the printed value always matches what resolveCommitPolicy actually returns.
 *
 * Run: nr test:manual -- test-commit-policy-log-format
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { resolveCommitPolicy, type CommitComplexity } from '../../src/shared/utils/implement-commit-policy';
import type { PlanArtifact } from '../../src/shared/types/agent.types';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

const ANSI_ESCAPE_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

const { counts, pass, fail } = createReporter();

function buildPlanArtifact(complexity: CommitComplexity): PlanArtifact {
  return {
    plan: {
      action: 'fix',
      summary: 'test plan',
      steps: ['do the thing'],
      estimatedComplexity: complexity,
    },
    action: 'fix',
    path: '/tmp/plan.json',
  };
}

async function testComplexityTier(agent: ImplementerAgent, complexity: CommitComplexity): Promise<void> {
  const expectedAllowed = resolveCommitPolicy(complexity).allowsCommit;
  const expectedWord = expectedAllowed ? 'allowed' : 'blocked';

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    const buildConventionsSection = (agent as unknown as Record<string, (...a: unknown[]) => string>)['buildConventionsSection'];
    buildConventionsSection.call(agent, process.cwd(), 'test-repo', buildPlanArtifact(complexity));
  } finally {
    console.log = originalLog;
  }

  const policyLines = lines.filter(l => l.includes('Commit policy:'));
  if (policyLines.length !== 1) {
    fail(`[${complexity}] Expected exactly 1 "Commit policy:" line, got ${policyLines.length}: ${JSON.stringify(policyLines)}`);
    return;
  }

  const line = policyLines[0];
  const stripped = line.replaceAll(ANSI_ESCAPE_PATTERN, '');

  if (!new RegExp(`^\\s*Commit policy: ${expectedWord}$`).test(stripped)) {
    fail(`[${complexity}] Expected "Commit policy: ${expectedWord}", got "${stripped}"`);
    return;
  }

  if (/->/.test(stripped) || /commits (allowed|blocked)/.test(stripped)) {
    fail(`[${complexity}] Old format leaked into output: "${stripped}"`);
    return;
  }

  pass(`[${complexity}] Printed "Commit policy: ${expectedWord}" with no complexity/arrow segment`);
}

async function main(): Promise<void> {
  console.log('Manual smoke: commit policy log format\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const agent = app.get(ImplementerAgent);

  for (const complexity of ['low', 'medium', 'high'] as const) {
    await testComplexityTier(agent, complexity);
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: commit policy log format');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
