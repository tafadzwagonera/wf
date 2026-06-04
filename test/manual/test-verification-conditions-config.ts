/**
 * Smoke test: verification conditions config rename and v2 manifest support.
 *
 * Validates:
 * - normalizeWfConfig accepts verificationConditions on implement stage
 * - normalizeWfConfig rejects afterImplement (no backward compat)
 * - parseVerificationManifest handles v1 manifests
 * - parseVerificationManifest handles v2 manifests with stage scoping
 * - parseVerificationManifest returns empty baseline for missing v2 stage
 * - parseVerificationManifest rejects unsupported versions
 * - loadVerificationManifest passes stage through to parser
 *
 * Run: nr test:manual -- test-verification-conditions-config
 */

import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import {
  parseVerificationManifest,
  loadVerificationManifest,
} from '../../src/shared/utils/verification-manifest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
};

console.log('\n--- verificationConditions config ---');

const configWithVC = normalizeWfConfig({
  ai: [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4' }],
  stages: {
    implement: {
      provider: 'openai',
      model: 'gpt-5.4',
      verificationConditions: {
        policyFile: '.wf/verification.json',
      },
    },
  },
});

assert(
  'verificationConditions.policyFile is normalized',
  configWithVC.stages.implement?.verificationConditions?.policyFile ===
    '.wf/verification.json',
);
assert(
  'verificationConditions.scripts defaults to empty object',
  JSON.stringify(
    configWithVC.stages.implement?.verificationConditions?.scripts,
  ) === '{}',
);

console.log('\n--- afterImplement is rejected ---');

let afterImplementRejected = false;
try {
  normalizeWfConfig({
    ai: [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4' }],
    stages: {
      implement: {
        provider: 'openai',
        model: 'gpt-5.4',
        afterImplement: { policyFile: 'x.json' },
      } as any,
    },
  });
} catch {
  afterImplementRejected = true;
}
assert('afterImplement is rejected by Joi validation', afterImplementRejected);

console.log('\n--- v1 manifest parsing ---');

const v1Result = parseVerificationManifest(
  JSON.stringify({
    version: 1,
    baseline: [{ id: 'lint', run: 'npm run lint', policy: 'enforced' }],
  }),
  '/tmp/v1.json',
);
assert('v1 manifest returns baseline', v1Result.baseline.length === 1);
assert(
  'v1 manifest baseline step has correct id',
  v1Result.baseline[0].id === 'lint',
);

console.log('\n--- v2 manifest parsing ---');

const v2Result = parseVerificationManifest(
  JSON.stringify({
    version: 2,
    implement: {
      baseline: [{ id: 'build', run: 'npm run build', policy: 'enforced' }],
    },
    review: { baseline: [] },
  }),
  '/tmp/v2.json',
  'implement',
);
assert(
  'v2 manifest returns implement baseline',
  v2Result.baseline.length === 1,
);
assert(
  'v2 manifest baseline step has correct id',
  v2Result.baseline[0].id === 'build',
);

const v2MissingStage = parseVerificationManifest(
  JSON.stringify({
    version: 2,
    implement: {
      baseline: [{ id: 'build', run: 'npm run build', policy: 'enforced' }],
    },
  }),
  '/tmp/v2.json',
  'generate',
);
assert(
  'v2 manifest returns empty baseline for missing stage',
  v2MissingStage.baseline.length === 0,
);

console.log('\n--- v2 manifest defaults to implement stage ---');

const v2DefaultStage = parseVerificationManifest(
  JSON.stringify({
    version: 2,
    implement: {
      baseline: [{ id: 'lint', run: 'npm run lint', policy: 'enforced' }],
    },
  }),
  '/tmp/v2.json',
);
assert(
  'v2 manifest without stage param defaults to implement',
  v2DefaultStage.baseline.length === 1,
);

console.log('\n--- unsupported version ---');

let unsupportedVersionThrew = false;
try {
  parseVerificationManifest(
    JSON.stringify({ version: 99, baseline: [] }),
    '/tmp/bad.json',
  );
} catch {
  unsupportedVersionThrew = true;
}
assert('unsupported manifest version throws', unsupportedVersionThrew);

console.log('\n--- loadVerificationManifest with stage ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-vc-smoke-'));
const manifestPath = path.join(tmpDir, 'verification.json');
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    version: 2,
    implement: {
      baseline: [
        { id: 'format', run: 'npm run format', policy: 'best_effort' },
      ],
    },
  }),
);

const loaded = loadVerificationManifest(manifestPath, 'implement');
assert(
  'loadVerificationManifest passes stage to parser',
  loaded.baseline.length === 1 && loaded.baseline[0].id === 'format',
);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
