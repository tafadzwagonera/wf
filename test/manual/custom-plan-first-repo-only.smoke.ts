/**
 * Manual smoke test: --custom-plan locates its source from the first --repos value only
 *
 * Run (after `yarn build`): nr test:manual custom-plan-first-repo-only.smoke
 *
 * Scenario: `node dist/main.js issue:plan|issue --action fix --custom-plan spec.md --repos repo repo-b` with a
 * fake `claude` on PATH, an isolated HOME, and `spec.md` placed in `~/.wf/repo/` and/or `~/.wf/repo-b/`.
 *
 * Verify:
 *   1. issue:plan warns that the first repository is used and the rest are ignored, with or without --silent.
 *   2. issue:plan exits 0 with `spec.md` in both repos: no "matches multiple repositories" error.
 *   3. issue:plan writes its plan under `~/.wf/repo/` and nothing under `~/.wf/repo-b/`.
 *   4. A single --repos value produces no warning.
 *   5. `issue --to plan` warns that only the first repository is searched for the source and writes the plan
 *      under `~/.wf/repo/`.
 *   6. `issue --to plan` fails with a not-found error naming `~/.wf/repo/spec.md` when the source exists only in
 *      the second repository.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); requires `yarn build`.
 * Teardown: the temp root (repo, sibling repo-b, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { cleanupPlanHarness, runPlanCli, runWfCli, setupPlanHarness, type PlanHarness } from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const WARNING = '--custom-plan uses only the first --repos value "repo"; ignoring: repo-b';
const ISSUE_WARNING = '--custom-plan uses only the first --repos value "repo" to locate the source; not searched: repo-b';

const plan = {
  action: 'fix',
  summary: 'Smoke plan for first-repo-only resolution',
  steps: ['Edit repo/src/index.ts.'],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/index.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
};

const artifactDir = (harness: PlanHarness, repo: string): string => path.join(harness.homeDir, '.wf', repo);

const planArtifacts = (harness: PlanHarness, repo: string): string[] => {
  const dir = artifactDir(harness, repo);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('-plan.json')) : [];
};

const withHarness = (fn: (harness: PlanHarness) => void, sourceRepos = ['repo', 'repo-b']): void => {
  const harness = setupPlanHarness('wf-first-repo-', plan, { 'src/index.ts': 'export const x = 1;\n' });
  try {
    fs.mkdirSync(path.join(harness.tempRoot, 'repo-b'), { recursive: true });
    for (const repo of sourceRepos) {
      fs.mkdirSync(artifactDir(harness, repo), { recursive: true });
      fs.writeFileSync(path.join(artifactDir(harness, repo), 'spec.md'), '# Spec\n\nSmoke source.\n');
    }
    fn(harness);
  } finally {
    cleanupPlanHarness(harness);
  }
};

function verifyExtraReposAreIgnoredWithWarning(): void {
  withHarness(harness => {
    const { exitCode, output } = runPlanCli(harness, ['--action', 'fix', '--custom-plan', 'spec.md', '--repos', 'repo', 'repo-b']);
    assert('warning names the first repo and the ignored repos', output.includes(WARNING), output.slice(-800));
    assert('duplicate source in the ignored repo is not an error', exitCode === 0 && !output.includes('matches multiple repositories'), output.slice(-800));
    assert('plan artifact is written under the first repo', planArtifacts(harness, 'repo').length === 1);
    assert('nothing is written under the ignored repo', planArtifacts(harness, 'repo-b').length === 0);
  });
}

function verifyWarningSurvivesSilentMode(): void {
  withHarness(harness => {
    const { output } = runPlanCli(harness, ['--action', 'fix', '--custom-plan', 'spec.md', '--repos', 'repo', 'repo-b', '--silent']);
    assert('warning is shown with --silent', output.includes(WARNING), output.slice(-800));
  });
}

function verifySingleRepoDoesNotWarn(): void {
  withHarness(harness => {
    const { exitCode, output } = runPlanCli(harness, ['--action', 'fix', '--custom-plan', 'spec.md', '--repos', 'repo']);
    assert('single --repos value exits 0', exitCode === 0, output.slice(-800));
    assert('single --repos value produces no warning', !output.includes('--custom-plan uses only the first'), output.slice(-800));
  });
}

const issueArgs = ['issue', '--action', 'fix', '--custom-plan', 'spec.md', '--repos', 'repo', 'repo-b', '--to', 'plan'];

function verifyIssueWarnsAndSearchesFirstRepoOnly(): void {
  withHarness(harness => {
    const { exitCode, output } = runWfCli(harness, issueArgs);
    assert('issue warns that only the first repo is searched', output.includes(ISSUE_WARNING), output.slice(-800));
    assert('issue exits 0 with the source in both repos', exitCode === 0 && !output.includes('matches multiple repositories'), output.slice(-800));
    assert('issue writes the plan under the first repo', planArtifacts(harness, 'repo').length === 1);
    assert('issue writes nothing under the second repo', planArtifacts(harness, 'repo-b').length === 0);
  });
}

function verifyIssueDoesNotSearchSecondRepo(): void {
  withHarness(harness => {
    const { exitCode, output } = runWfCli(harness, issueArgs);
    const expectedPath = path.join(artifactDir(harness, 'repo'), 'spec.md');
    assert('issue fails when the source exists only in the second repo', exitCode !== 0, output.slice(-800));
    assert('error names the first repo artifact path', output.includes(`not found in artifact repository: ${expectedPath}`), output.slice(-800));
  }, ['repo-b']);
}

console.log(chalk.bold('\ncustom-plan-first-repo-only smoke test\n'));
verifyExtraReposAreIgnoredWithWarning();
verifyWarningSurvivesSilentMode();
verifySingleRepoDoesNotWarn();
verifyIssueWarnsAndSearchesFirstRepoOnly();
verifyIssueDoesNotSearchSecondRepo();
summarise(counts);
