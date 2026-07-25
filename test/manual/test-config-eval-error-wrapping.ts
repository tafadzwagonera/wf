/**
 * Smoke test: evaluateConfigScript wraps VM errors with file path context.
 *
 * Validates:
 * - SyntaxError from CJS config in ESM package is wrapped as ValidationError with file path
 * - ReferenceError from CJS config in ESM package is wrapped as ValidationError with file path
 * - Valid CJS config in ESM package still loads without error (no regression)
 * - ValidationError from Zod schema validation is not double-wrapped
 *
 * Run: nr test:manual -- test-config-eval-error-wrapping
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWfConfig } from '../../src/config/wf-config-loader';
import { ValidationError } from '../../src/shared/utils/errors';

let passed = 0;
let failed = 0;
const tempDirs: string[] = [];

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
};

const createTempProject = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eval-test-'));
  tempDirs.push(dir);
  return dir;
};

const run = async (): Promise<void> => {
  // --- Case A: SyntaxError from CJS config in ESM package ---

  console.log('\n--- Case A: SyntaxError from CJS config in ESM package ---');

  const projectA = createTempProject();
  fs.writeFileSync(path.join(projectA, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(path.join(projectA, 'wf.config.js'), 'module.exports = { ai: [{ provider: : }] };\n');

  const errorA = await loadWfConfig({ cwd: projectA }).catch((e: unknown) => e);

  assert('throws ValidationError for SyntaxError', errorA instanceof ValidationError);
  assert(
    'message includes file path',
    errorA instanceof ValidationError && /Failed to evaluate config file.*wf\.config\.js/.test(errorA.message),
  );
  assert(
    'message preserves original SyntaxError text',
    errorA instanceof ValidationError && /unexpected token/i.test(errorA.message),
  );

  // --- Case B: ReferenceError from ESM-fallback config ---

  console.log('\n--- Case B: ReferenceError from CJS config in ESM package ---');

  const projectB = createTempProject();
  fs.writeFileSync(path.join(projectB, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(
    path.join(projectB, 'wf.config.js'),
    'module.exports = { ai: [{ provider: undeclaredVariable }] };\n',
  );

  const errorB = await loadWfConfig({ cwd: projectB }).catch((e: unknown) => e);

  assert('throws ValidationError for ReferenceError', errorB instanceof ValidationError);
  assert(
    'message includes file path',
    errorB instanceof ValidationError && /Failed to evaluate config file/.test(errorB.message),
  );
  assert(
    'message preserves original ReferenceError text',
    errorB instanceof ValidationError && /undeclaredVariable/.test(errorB.message),
  );

  // --- Case C: Valid CJS config in ESM package loads correctly ---

  console.log('\n--- Case C: Valid CJS config in ESM package (no regression) ---');

  const projectC = createTempProject();
  fs.writeFileSync(path.join(projectC, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(
    path.join(projectC, 'wf.config.js'),
    'module.exports = { ai: [{ provider: "openai", apiKey: "k", model: "gpt-5.4" }] };\n',
  );

  const configC = await loadWfConfig({ cwd: projectC });

  assert('loads without error', configC !== undefined);
  assert('resolves provider', configC.ai.provider === 'openai');
  assert('resolves model', configC.ai.model === 'gpt-5.4');

  // --- Case D: Zod ValidationError is not double-wrapped ---

  console.log('\n--- Case D: Zod ValidationError is not double-wrapped ---');

  const projectD = createTempProject();
  fs.writeFileSync(path.join(projectD, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(
    path.join(projectD, 'wf.config.js'),
    'module.exports = { branching: { atlassianPattern: "^test$" } };\n',
  );

  const errorD = await loadWfConfig({ cwd: projectD }).catch((e: unknown) => e);

  assert('throws ValidationError for schema violation', errorD instanceof ValidationError);
  assert(
    'message is from Zod validation, not from eval wrapping',
    errorD instanceof ValidationError && /validation failed/i.test(errorD.message),
  );
  assert(
    'message does not contain eval-wrapping prefix',
    errorD instanceof ValidationError && !/Failed to evaluate config file/.test(errorD.message),
  );

  // --- Cleanup & Summary ---

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
};

run();
