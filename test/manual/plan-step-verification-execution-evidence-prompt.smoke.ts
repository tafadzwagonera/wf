import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import type { AssessableStep } from '../../src/agents/step-spec-fidelity.service';
import {
  buildStepAssessorPrompt,
  collectPushEvidence,
  type ExecutionEvidence,
} from '../../src/agents/plan-step-verification.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const initRepo = (repoDir: string): void => {
  const runGit = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  };
  runGit('init');
  runGit('config', 'user.email', 'wf@example.test');
  runGit('config', 'user.name', 'wf');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'export const value = 1;\n');
  runGit('add', '.');
  runGit('commit', '-m', 'baseline');
  fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'export const value = 2;\n');
};

const buildSteps = (): AssessableStep[] => [{ index: 0, text: 'Run yarn test and ensure all tests pass' }];

const buildEvidence = (): ExecutionEvidence => ({
  outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
  commitPolicy: { allowsCommit: false, complexity: 'medium' },
  stagedFiles: ['src/foo.ts'],
  commitsSinceBaseline: 1,
});

const assertOrdering = (prompt: string): void => {
  const diffIdx = prompt.indexOf('## Per-file diffs');
  const evidIdx = prompt.indexOf('## Command execution evidence');
  const rulesIdx = prompt.indexOf('## Status rules');
  if (diffIdx < evidIdx) {
    pass('## Command execution evidence appears after ## Per-file diffs');
  } else {
    fail('ordering: ## Command execution evidence not after ## Per-file diffs', `diff=${diffIdx} evid=${evidIdx}`);
  }
  if (evidIdx < rulesIdx) {
    pass('## Command execution evidence appears before ## Status rules');
  } else {
    fail('ordering: ## Command execution evidence not before ## Status rules', `evid=${evidIdx} rules=${rulesIdx}`);
  }
};

const assertEvidenceHeaders = (prompt: string): void => {
  if (prompt.includes('## Command evidence rules')) {
    pass('prompt contains ## Command evidence rules');
  } else {
    fail('prompt missing ## Command evidence rules');
  }
  if (prompt.includes('→ passed (exit 0; output not captured for passing commands) [policy: enforced]')) {
    pass('passed outcome rendered with canonical format');
  } else {
    fail('passed outcome not in expected format');
  }
};

const assertEvidenceContext = (prompt: string): void => {
  if (prompt.includes('Commit policy: blocked (complexity=medium)')) {
    pass('blocked commit policy line present');
  } else {
    fail('blocked commit policy line missing');
  }
  if (prompt.includes('Staged files: src/foo.ts')) {
    pass('staged files line present');
  } else {
    fail('staged files line missing');
  }
};

const assertCommitsLine = (prompt: string): void => {
  if (prompt.includes('Commits created since baseline: 1')) {
    pass('commits since baseline line present');
  } else {
    fail('commits since baseline line missing');
  }
};

const assertWithEvidence = (prompt: string): void => {
  assertOrdering(prompt);
  assertEvidenceHeaders(prompt);
  assertEvidenceContext(prompt);
  assertCommitsLine(prompt);
};

const assertWithoutEvidence = (prompt: string): void => {
  if (prompt.includes('## Command execution evidence')) {
    fail('two-arg call unexpectedly includes ## Command execution evidence');
  } else {
    pass('two-arg call omits ## Command execution evidence');
  }
  if (prompt.includes('## Command evidence rules')) {
    fail('two-arg call unexpectedly includes ## Command evidence rules');
  } else {
    pass('two-arg call omits ## Command evidence rules');
  }
};

const runAssertions = async (repoDir: string): Promise<void> => {
  const steps = buildSteps();
  const pushEvidence = await collectPushEvidence({ repoDir, baseRef: 'HEAD', stepTexts: steps.map(s => s.text) });
  const withEvidence = buildStepAssessorPrompt(steps, pushEvidence, buildEvidence());
  const withoutEvidence = buildStepAssessorPrompt(steps, pushEvidence);
  assertWithEvidence(withEvidence);
  assertWithoutEvidence(withoutEvidence);
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  plan-step-verification execution evidence prompt injection smoke test\n'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-evid-prompt-'));
  try {
    initRepo(repoDir);
    await runAssertions(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
