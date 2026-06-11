/**
 * Manual Smoke Test: Windsurf Removal
 *
 * Verifies that all Windsurf workflow infrastructure has been removed
 * and the issue:* pipeline remains intact.
 *
 * Run: nr test:manual -- test-windsurf-removal
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
let failures = 0;

const pass = (label: string) => console.log(`  ✓ ${label}`);
const fail = (label: string, detail?: string) => {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  failures++;
};

const assert = (condition: boolean, label: string, detail?: string) => {
  if (condition) pass(label);
  else fail(label, detail);
};

console.log('🧪 Windsurf Removal Smoke Test\n');

// 1. Deleted directories must not exist
console.log('1. Deleted directories');
for (const dir of [
  '.windsurf',
  'src/core/workflow-parser',
  'src/core/stage-engine',
  'src/core/state-manager',
  'src/core/approval-system',
  'src/common/interfaces',
]) {
  const fullPath = path.join(ROOT, dir);
  assert(!fs.existsSync(fullPath), `${dir} does not exist`);
}

// 2. Deleted command files must not exist
console.log('\n2. Deleted command files');
for (const file of [
  'src/commands/run.command.ts',
  'src/commands/run.command.spec.ts',
  'src/commands/list.command.ts',
  'src/commands/resume.command.ts',
  'src/commands/history.command.ts',
  'src/commands/validate.command.ts',
]) {
  assert(!fs.existsSync(path.join(ROOT, file)), `${file} does not exist`);
}

// 3. No windsurf references in src/
console.log('\n3. No windsurf references in source');
try {
  const grepResult = execSync(`grep -ri "windsurf" ${SRC} || true`, {
    encoding: 'utf-8',
  }).trim();
  assert(
    grepResult === '',
    'No windsurf matches in src/',
    grepResult.split('\n')[0],
  );
} catch {
  pass('No windsurf matches in src/');
}

// 4. No windsurf references in config files
console.log('\n4. No windsurf references in config files');
for (const file of ['wf.config.ts', 'README.md', '.gitignore']) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  assert(!content.toLowerCase().includes('windsurf'), `No windsurf in ${file}`);
}

// 5. workflows config removed from public-config.ts
console.log('\n5. Config cleanup');
const publicConfig = fs.readFileSync(
  path.join(SRC, 'config/public-config.ts'),
  'utf-8',
);
assert(
  !publicConfig.includes('workflows?'),
  'No workflows property in WfConfig',
);

const validationSchema = fs.readFileSync(
  path.join(SRC, 'config/validation.schema.ts'),
  'utf-8',
);
assert(
  !validationSchema.includes('WORKFLOW_DIRECTORY'),
  'No WORKFLOW_DIRECTORY in validation schema',
);
assert(
  !validationSchema.includes('WORKFLOW_AUTO_DISCOVERY'),
  'No WORKFLOW_AUTO_DISCOVERY in validation schema',
);

// 6. config.command.ts has no Workflow Settings section
console.log('\n6. Config command cleanup');
const configCommand = fs.readFileSync(
  path.join(SRC, 'commands/config.command.ts'),
  'utf-8',
);
assert(
  !configCommand.includes('Workflow Settings'),
  'No Workflow Settings in config.command.ts',
);

// 7. Issue commands still exist
console.log('\n7. Issue pipeline intact');
for (const file of [
  'src/commands/issue.command.ts',
  'src/commands/issue-fetch.command.ts',
  'src/commands/issue-plan.command.ts',
  'src/commands/issue-implement.command.ts',
  'src/commands/issue-review.command.ts',
  'src/commands/issue-commit.command.ts',
  'src/commands/issue-create.command.ts',
  'src/commands/issue-generate.command.ts',
  'src/commands/issue-pr.command.ts',
  'src/commands/config.command.ts',
]) {
  assert(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
}

// 8. Build output exists (dist/)
console.log('\n8. Build output');
assert(fs.existsSync(path.join(ROOT, 'dist/main.js')), 'dist/main.js exists');

// 9. Help catalog does not mention deleted commands
console.log('\n9. Help catalog');
const catalogPath = path.join(ROOT, 'docs/commands-help.catalog.json');
if (fs.existsSync(catalogPath)) {
  const catalog = fs.readFileSync(catalogPath, 'utf-8');
  for (const cmd of ['run', 'list', 'resume', 'history', 'validate']) {
    assert(
      !catalog.includes(`"${cmd}"`),
      `No "${cmd}" command in help catalog`,
    );
  }
} else {
  fail('Help catalog exists');
}

console.log(
  `\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
