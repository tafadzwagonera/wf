import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';

let passed = 0;
let failed = 0;

const pass = (msg: string) => {
  console.log(chalk.green(`  PASS  ${msg}`));
  passed++;
};

const fail = (msg: string, detail?: string) => {
  const suffix = detail ? '\n    → ' + detail : '';
  console.error(chalk.red('  FAIL  ' + msg + suffix));
  failed++;
};

const BASE_AI = [{ provider: 'anthropic' as const, model: 'claude-sonnet-4-6', apiKey: 'k' }];

async function main(): Promise<void> {
  console.log('Manual smoke: stallWindow accepted, maxRounds rejected by config schema\n');

  try {
    const result = normalizeWfConfig({
      ai: BASE_AI,
      stages: { implement: { provider: 'anthropic', planStepVerification: { enabled: true, stallWindow: 5 } } },
    });
    const psv = result.stages?.implement?.planStepVerification;
    if (psv?.stallWindow === 5) {
      pass('normalizeWfConfig accepts stallWindow: 5 without throwing');
    } else {
      fail('stallWindow: 5 was not preserved through normalisation', JSON.stringify(psv));
    }
    if (psv?.enabled === true && psv?.stallWindow === 5) {
      pass('Normalized output includes both enabled and stallWindow intact');
    } else {
      fail('Expected { enabled: true, stallWindow: 5 }', JSON.stringify(psv));
    }
  } catch (err) {
    fail('normalizeWfConfig with stallWindow: 5 threw unexpectedly', String(err));
    fail('Normalized output assertion skipped due to prior throw');
  }

  // Assertion 2: maxRounds: 5 throws with a Zod error naming maxRounds
  try {
    normalizeWfConfig({
      ai: BASE_AI,
      stages: { implement: { provider: 'anthropic', planStepVerification: { maxRounds: 5 } as any } },
    });
    fail('Expected normalizeWfConfig with maxRounds: 5 to throw a ZodError');
  } catch (err) {
    const message = String(err);
    if (message.includes('planStepVerification') || message.toLowerCase().includes('validation')) {
      pass('normalizeWfConfig with maxRounds: 5 throws pointing at planStepVerification');
    } else {
      fail('Expected a ValidationError naming planStepVerification', message.slice(0, 300));
    }
  }

  try {
    normalizeWfConfig({
      ai: BASE_AI,
      stages: { implement: { provider: 'anthropic', planStepVerification: { stallWindow: 0 } } },
    });
    fail('Expected stallWindow: 0 to be rejected (min(1) constraint)');
  } catch {
    pass('stallWindow: 0 is rejected by the schema (min(1) enforced)');
  }

  try {
    const result = normalizeWfConfig({
      ai: BASE_AI,
      stages: { implement: { provider: 'anthropic', planStepVerification: { stallWindow: 1 } } },
    });
    if (result.stages?.implement?.planStepVerification?.stallWindow === 1) {
      pass('stallWindow: 1 is accepted as the valid lower boundary');
    } else {
      fail('stallWindow: 1 was not preserved', JSON.stringify(result.stages?.implement?.planStepVerification));
    }
  } catch (err) {
    fail('normalizeWfConfig with stallWindow: 1 threw unexpectedly', String(err));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: stallWindow config field validation');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
