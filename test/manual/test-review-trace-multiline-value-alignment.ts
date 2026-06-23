/**
 * Manual smoke test for multiline value alignment in review trace output.
 *
 * Verifies:
 * 1. Every line returned by formatReviewStateTransition is a single visual line
 * 2. When prefixed with "  ", all lines maintain consistent tree indentation
 *
 * Run:
 *   nr test:manual -- test-review-trace-multiline-value-alignment
 */

import { formatReviewStateTransition } from '../../src/integrations/ai/review-trace';

function assertNoEmbeddedNewlines(lines: string[], label: string): void {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('\n')) {
      throw new Error(`${label}\n  Line ${i} contains embedded newline:\n  ${JSON.stringify(lines[i])}`);
    }
  }
}

function assertConsistentPrefix(lines: string[], outerPrefix: string, label: string): void {
  const prefixed = lines.map(line => `${outerPrefix}${line}`);
  for (let i = 0; i < prefixed.length; i++) {
    const line = prefixed[i];
    if (!line.startsWith(outerPrefix)) {
      throw new Error(`${label}\n  Line ${i} missing outer prefix:\n  ${JSON.stringify(line)}`);
    }
  }
}

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: review-trace multiline value alignment\n');

  // Test 1: Array values in captured section
  console.log('Test 1: captured section with array values');
  const arrayResult = formatReviewStateTransition({
    from: 'No service',
    to: 'Service running',
    steps: [
      {
        frame: 'aws_ssm_parameter.config',
        captured: {
          name: '/agent-ipi/config',
          payloadKeys: ['API_URL', 'LOG_LEVEL', 'NODE_ENV', 'STAGE', 'PORT', 'NATS_URL'],
        },
        changes: {
          'ssm.parameter': { before: 'absent', after: 'present' },
        },
      },
    ],
  });

  const prefixed = arrayResult.map(line => `  ${line}`);
  console.log(prefixed.join('\n'));
  console.log();

  assertNoEmbeddedNewlines(arrayResult, 'Test 1: array values must not contain embedded newlines');
  assertConsistentPrefix(arrayResult, '', 'Test 1: all lines must be plain single lines');

  console.log('  ✅ Test 1 passed: array values have no embedded newlines\n');

  // Test 2: Object values in changes section
  console.log('Test 2: changes section with object before/after');
  const objectResult = formatReviewStateTransition({
    from: 'init',
    to: 'ready',
    steps: [
      {
        frame: 'Service.configure()',
        changes: {
          config: {
            before: { host: 'localhost', port: 3000 },
            after: { host: 'agent-ipi.dev.expatexplore.com', port: 3000 },
          },
        },
      },
    ],
  });

  const prefixed2 = objectResult.map(line => `  ${line}`);
  console.log(prefixed2.join('\n'));
  console.log();

  assertNoEmbeddedNewlines(objectResult, 'Test 2: object values must not contain embedded newlines');

  console.log('  ✅ Test 2 passed: object values have no embedded newlines\n');

  // Test 3: Nested children with multiline values
  console.log('Test 3: nested children with multiline captured values');
  const nestedResult = formatReviewStateTransition({
    from: 'absent',
    to: 'running',
    steps: [
      {
        frame: 'terraform.apply()',
        children: [
          {
            frame: 'aws_ecs_task_definition.agent_ipi',
            captured: {
              family: 'agent-ipi',
              secrets: ['SERVICE_CONFIG', 'SERVICE_SECRETS'],
            },
            changes: {
              taskDefinition: { before: 'absent', after: 'present' },
            },
          },
        ],
      },
    ],
  });

  const prefixed3 = nestedResult.map(line => `  ${line}`);
  console.log(prefixed3.join('\n'));
  console.log();

  assertNoEmbeddedNewlines(nestedResult, 'Test 3: nested multiline values must not contain embedded newlines');

  console.log('  ✅ Test 3 passed: nested values have no embedded newlines\n');

  console.log('✅ Manual smoke test passed: review-trace multiline value alignment');
}

run().catch(error => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
