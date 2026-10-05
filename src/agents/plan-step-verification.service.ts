import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { appendToLogFile } from '../shared/logger/log-file-writer';
import { stepAssessmentResponseJsonSchema, stepAssessmentResponseSchema } from '../shared/schemas/step-verification.schema';
import type { StepAssessment, StepVerificationSummary } from '../shared/types/step-verification.types';
import { isAiProviderErrorLike } from '../shared/utils/errors';
import type { WfAiProviderName, WfBackendMode, WfStepVerificationMode } from '../shared/types/config.types';
import { PullStepAssessorService } from './pull-step-assessor.service';
import type { AssessableStep } from './step-spec-fidelity.service';
import { executeAsyncWithCatch, executeWithCatch } from '../shared/utils/execute-with-catch';
import type { VerificationOutcome } from '../shared/types/agent.types';
import type { CommitPolicy } from '../shared/utils/implement-commit-policy';

const execFileAsync = promisify(execFile);
const MAX_ASSESSOR_EVIDENCE_CHARS = 60_000;
const PER_FILE_DIFF_CHARS = 8_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

const countStatuses = (statuses: Iterable<StepAssessment>): Record<StepAssessment['status'], number> => {
  const counts = { done: 0, 'not-applicable': 0, 'partially-done': 0, 'not-done': 0, unverifiable: 0 };
  for (const status of statuses) counts[status.status]++;
  return counts;
};

const STEP_ASSESSOR_SYSTEM_PROMPT
  = 'You are a meticulous implementation auditor. Judge only from the evidence provided. Output ONLY valid JSON.';

const STEP_ASSESSOR_SYSTEM_PROMPT_WITH_SCHEMA
  = STEP_ASSESSOR_SYSTEM_PROMPT
    + '\n\nRespond with a JSON object matching this schema exactly:\n'
    + JSON.stringify(stepAssessmentResponseJsonSchema, null, 2);

const stepAssessorPreamble = [
  STEP_ASSESSOR_SYSTEM_PROMPT,
  '',
  '## Steps to assess',
];

const stepAssessorRules = [
  '## Status rules',
  '- done: fully implemented in the evidence',
  '- partially-done: started but incomplete (requires missing field)',
  '- not-done: not implemented, including any step whose named file shows no change in the changed-files list (requires missing field)',
  '- not-applicable: step requires no code change or cannot be proven by a diff (e.g. run-the-tests steps, confirm-existing-behavior steps) — use instead of not-done for such steps',
  '- unverifiable: ONLY for temporal, process, or investigation claims that evidence cannot in principle prove or disprove (requires missing field)',
  '- Paths under another repository prefix are outside this assessment; judge only the current repository portion.',
  '',
  'Index each step ONLY by its [Plan step N] tag. A step\'s own text may contain other numbers '
  + '(e.g. an internal "Step N (RED)/(GREEN)" label) — those are part of that step\'s content, not separate steps to assess.',
  'Produce exactly one entry per [Plan step N] tag above — no more, no fewer — in this shape:',
  '{"statuses":[{"index":0,"status":"done"},{"index":1,"status":"partially-done","missing":"…"}]}',
  'Do not assume changes you cannot see.',
];

const commandEvidenceRules = [
  '## Command evidence rules',
  '- Matched command step with passed outcome: mark done',
  '- Matched command step with failed outcome: mark not-done (cite the failure output as what is missing)',
  '- Command step matched to a skipped outcome or with no matching entry: mark not-applicable',
  '- Stage-and-commit step with a blocked commit policy and staged or working-tree changes: mark done'
  + ' — the implement stage intentionally leaves work staged; this satisfies the step',
  '- Never mark a policy-blocked commit step as not-done or unverifiable',
];

const verificationPromptFooter = [
  '',
  'Address ONLY the steps listed above. Read the relevant files first, then apply edits to complete each step fully.',
  'After all edits are complete, run each verification command exactly as written.',
  'If a flagged claim cannot be implemented exactly as written, say why in the final message.',
  'Do not output any text or plan before making your first tool call.',
];

export type PushEvidence = {
  nameStatus: string;
  fileDiffSections: string[];
  untrackedSections: string[];
  omittedPaths: string[];
  truncatedUntrackedPaths: string[];
};

export type ExecutionEvidence = {
  outcomes: VerificationOutcome[];
  commitPolicy?: CommitPolicy;
  stagedFiles: string[];
  commitsSinceBaseline?: number;
};

type RetainedUntracked = { retained: string[]; remaining: number; truncatedPaths: string[] };
type PushEvidenceParams = { repoDir: string; baseRef: string; stepTexts: string[]; untrackedSections?: string[] };

const runGitDiff = async (repoDir: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['diff', ...args], { cwd: repoDir, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
};

const parseChangedPaths = (nameStatus: string): string[] => nameStatus
  .split('\n')
  .filter(Boolean)
  .map(line => line.split('\t').at(-1) ?? '')
  .filter(Boolean);

const orderByStepMention = (paths: string[], stepTexts: string[]): string[] => {
  const text = stepTexts.join('\n');
  return [...paths.filter(path => text.includes(path)), ...paths.filter(path => !text.includes(path))];
};

const untrackedSectionPath = (section: string, index: number): string =>
  /^### ([^\n]+)/.exec(section)?.[1] ?? `section-${index}`;

const retainUntrackedSections = (sections: string[], budget: number): RetainedUntracked => {
  let remaining = budget;
  const retained: string[] = [];
  const truncatedPaths: string[] = [];
  for (const [index, section] of sections.entries()) {
    remaining = retainUntrackedSection(section, index, remaining, retained, truncatedPaths);
  }
  return { retained, remaining, truncatedPaths };
};
const retainUntrackedSection = (
  section: string, index: number, remaining: number, retained: string[], truncatedPaths: string[],
): number => {
  const sectionPath = untrackedSectionPath(section, index);
  const capped = capEvidenceSection(section, remaining);
  if (!capped) {
    truncatedPaths.push(sectionPath);
    return remaining;
  }
  if (capped.length < section.length) truncatedPaths.push(sectionPath);
  retained.push(capped);
  return remaining - capped.length;
};

const capEvidenceSection = (section: string, budget: number): string | undefined => {
  const limit = Math.min(PER_FILE_DIFF_CHARS, budget);
  if (section.length <= limit) return section;
  const marker = '\n[truncated]';
  if (limit <= marker.length) return undefined;
  return `${section.slice(0, limit - marker.length)}${marker}`;
};

const capFileDiff = (path: string, diff: string, budget: number): string | undefined => {
  const heading = `### ${path}\n`;
  const limit = Math.min(PER_FILE_DIFF_CHARS, budget);
  if (limit <= heading.length) return undefined;
  if (heading.length + diff.length <= limit) return heading + diff;
  const marker = '\n[truncated]';
  const contentLength = limit - heading.length - marker.length;
  if (contentLength <= 0) return undefined;
  return `${heading}${diff.slice(0, contentLength)}${marker}`;
};

export const collectPushEvidence = async (params: PushEvidenceParams): Promise<PushEvidence> => {
  const nameStatus = await runGitDiff(params.repoDir, ['--name-status', params.baseRef]);
  const retainedUntracked = retainUntrackedSections(
    params.untrackedSections ?? [],
    Math.max(0, MAX_ASSESSOR_EVIDENCE_CHARS - nameStatus.length),
  );
  const collected = await collectFileDiffSections(params, parseChangedPaths(nameStatus), retainedUntracked.remaining);
  return buildPushEvidence(nameStatus, collected, retainedUntracked);
};

const buildPushEvidence = (
  nameStatus: string, collected: { sections: string[]; omittedPaths: string[] }, retained: RetainedUntracked,
): PushEvidence => ({
  nameStatus, fileDiffSections: collected.sections, untrackedSections: retained.retained,
  omittedPaths: collected.omittedPaths, truncatedUntrackedPaths: retained.truncatedPaths,
});

const countCommitsSinceBaseline = async (repoDir: string, baseRef?: string): Promise<number | undefined> => {
  if (!baseRef) return undefined;
  const gitArgs = ['rev-list', '--count', `${baseRef}..HEAD`];
  const [result] = await executeAsyncWithCatch({
    fn: () => execFileAsync('git', gitArgs, { cwd: repoDir, maxBuffer: GIT_MAX_BUFFER }),
    onError: () => undefined,
  });
  const count = parseInt(result?.stdout ?? '', 10);
  return Number.isFinite(count) ? count : undefined;
};

const collectFileDiffSections = async (
  params: PushEvidenceParams, paths: string[], initialBudget: number,
): Promise<{ sections: string[]; omittedPaths: string[]; remaining: number }> => {
  const state = { remaining: initialBudget, sections: [] as string[], omittedPaths: [] as string[] };
  for (const filePath of orderByStepMention(paths, params.stepTexts)) {
    await collectFileDiffSection(params, filePath, state);
  }
  return state;
};

const collectFileDiffSection = async (
  params: PushEvidenceParams, filePath: string,
  state: { remaining: number; sections: string[]; omittedPaths: string[] },
): Promise<void> => {
  if (state.remaining < PER_FILE_DIFF_CHARS / 4) {
    state.omittedPaths.push(filePath);
    return;
  }
  const diff = await runGitDiff(params.repoDir, [params.baseRef, '--', filePath]);
  const section = capFileDiff(filePath, diff, state.remaining);
  if (section) state.sections.push(section);
  else state.omittedPaths.push(filePath);
  state.remaining -= section?.length ?? 0;
};

type RoundResult = {
  outcome?: PlanStepVerificationOutcome;
  sessionId?: string;
  extraPassCount: number;
  assessmentFailed?: boolean;
  assessmentFailureCause?: string;
  pendingIndices?: number[];
};

type VerificationLoopState = {
  sessionId?: string;
  extraPassCount: number;
  consecutiveFailures: number;
  lastFailureCause?: string;
};

export interface PlanStepVerificationRunParams {
  steps: string[];
  planSummary: string;
  repoDir: string;
  /**
   * The commit HEAD was at before the implement stage ran, captured by
   * `ImplementerAgent.captureCommitBaseline`. `enforceCommitPolicy` soft-resets
   * back to this commit whenever the implement stage committed despite a
   * blocked commit policy — but that reset is skipped for a few safety cases
   * (branch changed, merge commits, commits already pushed). Diffing against
   * this fixed commit (rather than a moving `HEAD`) captures the full,
   * cumulative changeset in both cases: after a successful reset HEAD equals
   * this commit anyway, and when the reset is skipped this is the only ref
   * that still sees the committed-and-not-reset work. Falls back to `'HEAD'`
   * when there's no prior commit to anchor to (e.g. a brand-new repo).
   */
  baseRef?: string;
  verificationOutcomes?: VerificationOutcome[];
  commitPolicy?: CommitPolicy;
  mode?: WfStepVerificationMode;
  assessorProvider?: WfAiProviderName;
  assessorModel?: string;
  assessorBackend?: WfBackendMode;
  sessionId: string;
  stallWindow: number;
  silent?: boolean;
  runFixRound: (prompt: string, sessionId: string) => Promise<{ sessionId?: string; passCount?: number }>;
  /**
   * Called at the start of each assessment round to refresh the step list with
   * current spec-fidelity errors for only the supplied pending indices. When set, stall is detected by a rolling
   * pending-count history: the loop exits as stalled when the most-recent
   * pending count is no lower than the oldest count in the `stallWindow`-wide
   * window (i.e. no net improvement over the window). Must return a non-empty
   * index-to-text map — never null.
   */
  refreshSteps?: (indices: number[]) => Promise<Map<number, string>>;
  getSuppressed?: () => number;
}

export interface PlanStepVerificationOutcome {
  sessionId?: string;
  summary?: StepVerificationSummary;
  extraPassCount: number;
}

/**
 * Plan steps carry repo-prefixed paths (e.g. `shop-v1.1/specs/plan.json`) to disambiguate
 * files across a multi-repo workspace listing, but `git diff` output is always relative to
 * the repo's own root (e.g. `specs/plan.json`). Left unstripped, the assessor LLM sees two
 * differently-spelled paths for the same file and can wrongly conclude the step's file was
 * never touched. Stripping the `repoDir` basename prefix here aligns both sides.
 */
export const stripRepoNamePrefix = (steps: AssessableStep[], repoDir: string): AssessableStep[] => {
  const repoName = path.basename(repoDir);
  if (!repoName) return steps;
  const prefix = `${repoName}/`;
  return steps.map(step => ({ ...step, text: step.text.split(prefix).join('') }));
};

const maxOutcomeOutput = 4000;

const capOutcomeOutput = (output: string): string =>
  output.length > maxOutcomeOutput ? `${output.slice(0, maxOutcomeOutput)} [truncated]` : output;

const renderOutcomeLine = (outcome: VerificationOutcome): string => {
  if (outcome.status === 'passed') {
    return `- \`${outcome.command}\` → passed (exit 0; output not captured for passing commands) [policy: ${outcome.policy}]`;
  }
  const base = `- \`${outcome.command}\` → ${outcome.status} [policy: ${outcome.policy}]`;
  if (!outcome.output) return base;
  const indented = capOutcomeOutput(outcome.output).split('\n').map(l => `  ${l}`).join('\n');
  return `${base}\n  \`\`\`\n${indented}\n  \`\`\``;
};

const renderOutcomeLines = (outcomes: VerificationOutcome[]): string =>
  outcomes.length ? outcomes.map(renderOutcomeLine).join('\n') : '(no verification commands were executed)';

const renderCommitPolicyLine = (policy?: CommitPolicy): string => {
  if (!policy) return '';
  return policy.allowsCommit
    ? 'Commit policy: allowed'
    : `Commit policy: blocked (complexity=${policy.complexity})`;
};

const renderStagedLine = (stagedFiles: string[]): string =>
  stagedFiles.length ? `Staged files: ${stagedFiles.join(', ')}` : 'Staged files: none';

const buildEvidenceContextLines = (evidence: ExecutionEvidence): string[] =>
  [
    renderCommitPolicyLine(evidence.commitPolicy),
    renderStagedLine(evidence.stagedFiles),
    ...(evidence.commitsSinceBaseline !== undefined
      ? [`Commits created since baseline: ${evidence.commitsSinceBaseline}`]
      : []),
  ].filter(Boolean);

export const buildExecutionEvidenceSection = (evidence?: ExecutionEvidence): string => {
  if (!evidence) return '';
  return [
    '## Command execution evidence',
    '',
    'Verification commands executed at the end of the implement stage:',
    renderOutcomeLines(evidence.outcomes),
    '',
    ...buildEvidenceContextLines(evidence),
  ].join('\n');
};

export const buildStepAssessorPrompt = (
  steps: AssessableStep[],
  evidence: PushEvidence,
  executionEvidence?: ExecutionEvidence,
): string => {
  const numbered = steps.map(step => `[Plan step ${step.index}]\n${step.text}`).join('\n\n');
  const section = buildExecutionEvidenceSection(executionEvidence);
  const parts = [
    ...stepAssessorPreamble, numbered, buildPushEvidenceBody(evidence),
    ...(section ? [section, ''] : []), ...stepAssessorRules, ...(section ? commandEvidenceRules : []),
  ];
  return parts.join('\n');
};

const buildPushEvidenceBody = (evidence: PushEvidence): string => [
  '',
  '## Changed files (complete list)',
  evidence.nameStatus,
  '',
  '## Per-file diffs',
  evidence.fileDiffSections.join('\n\n'),
  buildOmittedEvidenceNote(evidence.omittedPaths),
  buildUntrackedEvidenceNote(evidence.untrackedSections),
  '',
].join('\n');
const buildOmittedEvidenceNote = (paths: string[]): string => paths.length ? `\nChanged but their hunks were omitted for size — the changed-files list above is authoritative: ${paths.join(', ')}` : '';
const buildUntrackedEvidenceNote = (sections: string[]): string => sections.length ? `\n\n## Untracked new files\n\n${sections.join('\n\n')}` : '';

type FixPromptArgs = {
  pending: StepAssessment[];
  round: number;
  stallWindow?: number;
  stepTexts: Map<number, string>;
};

export const buildPlanStepVerificationPrompt = (args: FixPromptArgs): string => {
  const { pending, round, stallWindow, stepTexts } = args;
  const stallWindowTag = stallWindow === undefined ? '' : ` (stall window: ${stallWindow})`;
  const roundHeader = `Verification round ${round}${stallWindowTag}: a post-implementation audit found plan steps that are not fully implemented.`;
  const stepLines = pending.flatMap(step => [
    `Step ${step.index} (${step.status})`,
    stepTexts.get(step.index) ?? '[Enriched step text unavailable]',
    `Missing: ${step.missing ?? 'No missing reason supplied'}`,
  ]);
  return [roundHeader, '', ...stepLines, ...verificationPromptFooter].join('\n');
};

const partitionAssessments = (
  statuses: StepAssessment[], expectedIndices: number[],
): { assessments: Map<number, StepAssessment>; droppedIndices: number[] } => {
  const expected = new Set(expectedIndices);
  const assessments = new Map<number, StepAssessment>();
  const droppedIndices: number[] = [];
  for (const status of statuses) {
    if (expected.has(status.index) && !assessments.has(status.index)) assessments.set(status.index, status);
    else droppedIndices.push(status.index);
  }
  return { assessments, droppedIndices };
};

const buildUnassessedFallback = (index: number): StepAssessment => ({
  index,
  status: 'not-done',
  missing: 'Not assessed in this round; assessor response omitted this index.',
});

@Injectable()
export class PlanStepVerificationService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
    private readonly presenter: CliPresenter,
    private readonly pullStepAssessor: PullStepAssessorService,
  ) {}

  async run(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    this.logEventAndAppendToLogFile('INFO', `step-verify.mode=${params.mode ?? 'push'}`, params.silent);
    const [outcome] = await executeAsyncWithCatch({
      fn: () => this.runVerificationLoop(params),
      rethrowIf: error => isAiProviderErrorLike(error) && error.category === 'auth',
      onError: error => {
        const cause = error instanceof Error ? error.message : String(error);
        this.logEventAndAppendToLogFile('ERROR', `step-verify.error cause=${cause}`, params.silent);
        return { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
      },
    });
    return outcome ?? { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
  }

  private async runVerificationLoop(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    let state = this.createVerificationLoopState(params.sessionId);
    const verificationState = this.createAssessmentState(params.steps);
    for (let round = 1; ; round += 1) {
      const result = await this.runOneRound(
        params, round, state.sessionId, state.extraPassCount, verificationState.pendingHistory,
        verificationState.settled, verificationState.pendingIndices,
      );
      if (result.outcome) return result.outcome;
      verificationState.pendingIndices = result.pendingIndices ?? verificationState.pendingIndices;
      state = this.resolveNextLoopState(state, result);
      const stalled = this.checkFailureLimit(state, params);
      if (stalled) return stalled;
    }
  }

  private createVerificationLoopState(sessionId?: string): VerificationLoopState {
    return { sessionId, extraPassCount: 0, consecutiveFailures: 0 };
  }

  private createAssessmentState(steps: string[]): {
    pendingHistory: number[];
    pendingIndices: number[];
    settled: Map<number, StepAssessment>;
  } {
    return { pendingHistory: [], pendingIndices: steps.map((_, index) => index), settled: new Map() };
  }

  private checkFailureLimit(
    state: VerificationLoopState, params: PlanStepVerificationRunParams,
  ): PlanStepVerificationOutcome | null {
    return this.checkConsecutiveFailureLimit(
      state.consecutiveFailures, params, state.sessionId, state.extraPassCount, state.lastFailureCause,
    );
  }

  private resolveNextLoopState(state: VerificationLoopState, result: RoundResult): VerificationLoopState {
    if (!result.assessmentFailed) {
      return { sessionId: result.sessionId, extraPassCount: result.extraPassCount, consecutiveFailures: 0 };
    }
    return {
      sessionId: result.sessionId,
      extraPassCount: result.extraPassCount,
      consecutiveFailures: state.consecutiveFailures + 1,
      lastFailureCause: result.assessmentFailureCause ?? state.lastFailureCause,
    };
  }

  private checkConsecutiveFailureLimit(
    count: number, params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number, failureCause?: string,
  ): PlanStepVerificationOutcome | null {
    if (!params.refreshSteps || count < params.stallWindow) return null;
    const causeTag = failureCause ? ` cause=${failureCause}` : '';
    this.logEventAndAppendToLogFile('WARN', `step-verify.exhausted reason=assessor-failed-${count}-rounds-in-a-row${causeTag} stallWindow=${params.stallWindow}`, params.silent);
    return { sessionId, summary: undefined, extraPassCount };
  }

  private async runOneRound(
    params: PlanStepVerificationRunParams,
    round: number, sessionId: string | undefined, extraPassCount: number, pendingHistory: number[],
    settled: Map<number, StepAssessment>, pendingIndices: number[],
  ): Promise<RoundResult> {
    const refreshed = params.refreshSteps ? await params.refreshSteps(pendingIndices) : undefined;
    const activeStepTexts = this.selectPendingStepTexts(pendingIndices, refreshed, params.steps);
    return this.executeRound(params, round, sessionId, extraPassCount, activeStepTexts, pendingHistory, settled);
  }

  private selectPendingStepTexts(
    pendingIndices: number[], refreshed: Map<number, string> | undefined, steps: string[],
  ): Map<number, string> {
    return new Map(pendingIndices.map(index => [index, refreshed?.get(index) ?? steps[index]]));
  }

  private async executeRound(
    params: PlanStepVerificationRunParams, round: number, sessionId: string | undefined,
    extraPassCount: number, activeStepTexts: Map<number, string>,
    pendingHistory: number[], settled: Map<number, StepAssessment>,
  ): Promise<RoundResult> {
    this.logRoundStart(params, round);
    const activeSteps = [...activeStepTexts].map(([index, text]) => ({ index, text }));
    const { steps: roundResults, failureCause } = await this.assessSteps(params, activeSteps);
    if (!roundResults) return this.handleAssessmentFailure(round, params, sessionId, extraPassCount, failureCause);
    this.settleTerminalAssessments(roundResults, settled);
    const { statusMap, pending } = this.mergeAndLogAssessments(roundResults, settled, params.silent);
    const outcome = this.resolveRound(statusMap, pending, round, params, sessionId, extraPassCount, pendingHistory);
    if (outcome || !sessionId) return this.finalizeRound(outcome, sessionId, extraPassCount);
    return this.runFixRound(params, pending, round, sessionId, extraPassCount, activeStepTexts);
  }

  private mergeAndLogAssessments(
    roundResults: Map<number, StepAssessment>, settled: Map<number, StepAssessment>, silent?: boolean,
  ): { statusMap: Map<number, StepAssessment>; pending: StepAssessment[] } {
    const statusMap = new Map([...settled, ...roundResults]);
    const pending = this.findPendingAssessments(statusMap);
    this.logPendingStatuses(statusMap, silent);
    return { statusMap, pending };
  }

  private resolveRound(
    statusMap: Map<number, StepAssessment>, pending: StepAssessment[], round: number,
    params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number, pendingHistory: number[],
  ): PlanStepVerificationOutcome | null {
    return this.resolveRoundOutcome(
      statusMap, pending, round, params, sessionId, extraPassCount, pendingHistory,
    );
  }

  private settleTerminalAssessments(
    assessments: Map<number, StepAssessment>, settled: Map<number, StepAssessment>,
  ): void {
    for (const assessment of assessments.values()) {
      if (assessment.status === 'done' || assessment.status === 'not-applicable' || assessment.status === 'unverifiable') {
        settled.set(assessment.index, assessment);
      }
    }
  }

  private async runFixRound(
    params: PlanStepVerificationRunParams, pending: StepAssessment[], round: number,
    sessionId: string, extraPassCount: number, stepTexts: Map<number, string>,
  ): Promise<RoundResult> {
    const fix = await params.runFixRound(this.buildFixPrompt(pending, round, params, stepTexts), sessionId);
    return {
      sessionId: fix.sessionId,
      extraPassCount: extraPassCount + (fix.passCount ?? 0),
      pendingIndices: pending.map(step => step.index),
    };
  }

  private findPendingAssessments(statusMap: Map<number, StepAssessment>): StepAssessment[] {
    return [...statusMap.values()].filter(s => s.status === 'partially-done' || s.status === 'not-done');
  }

  private logRoundStart(params: PlanStepVerificationRunParams, round: number): void {
    const roundLabel = params.refreshSteps ? `${round}/?` : `${round}/${params.stallWindow}`;
    this.logEventAndAppendToLogFile('INFO', `step-verify.round.start round=${roundLabel} stallWindow=${params.stallWindow}`, params.silent);
  }

  private buildFixPrompt(
    nowPending: StepAssessment[], round: number, params: PlanStepVerificationRunParams, stepTexts: Map<number, string>,
  ): string {
    return buildPlanStepVerificationPrompt({
      pending: nowPending,
      round,
      stallWindow: params.refreshSteps ? undefined : params.stallWindow,
      stepTexts,
    });
  }

  private finalizeRound(
    outcome: PlanStepVerificationOutcome | null, sessionId: string | undefined, extraPassCount: number,
  ): RoundResult {
    return { outcome: outcome ?? { sessionId, summary: undefined, extraPassCount }, extraPassCount };
  }

  private handleAssessmentFailure(
    round: number, params: PlanStepVerificationRunParams, sessionId: string | undefined, extraPassCount: number,
    failureCause?: string,
  ): RoundResult {
    if (params.refreshSteps || round < params.stallWindow) {
      return { sessionId, extraPassCount, assessmentFailed: true, assessmentFailureCause: failureCause };
    }
    const causeTag = failureCause ? ` cause=${failureCause}` : '';
    const reason = `step-verify.exhausted${causeTag} reason=assessment-failed-on-final-round round=${round} stallWindow=${params.stallWindow}`;
    this.logEventAndAppendToLogFile('WARN', reason, params.silent);
    return { outcome: { sessionId, summary: undefined, extraPassCount }, extraPassCount };
  }

  private resolveRoundOutcome(
    statusMap: Map<number, StepAssessment>, nowPending: StepAssessment[], round: number,
    params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number, pendingHistory: number[],
  ): PlanStepVerificationOutcome | null {
    if (!nowPending.length) {
      return this.resolveCompleteRound(statusMap, round, params, sessionId, extraPassCount);
    }
    const stalled = this.isRoundStalled(params, round, nowPending.length, pendingHistory);
    if (sessionId && !stalled) return null;
    return this.resolvePendingRound(statusMap, nowPending, round, params, sessionId, extraPassCount, pendingHistory);
  }

  private resolveCompleteRound(
    statusMap: Map<number, StepAssessment>, round: number, params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number,
  ): PlanStepVerificationOutcome {
    const counts = countStatuses(statusMap.values());
    this.logEventAndAppendToLogFile(
      'INFO',
      `step-verify.complete rounds=${round} steps=${statusMap.size} done=${counts.done} not-applicable=${counts['not-applicable']} unverifiable=${counts.unverifiable} partially-done=${counts['partially-done']} not-done=${counts['not-done']} pending=0`,
      params.silent,
    );
    return { sessionId, summary: { rounds: round, done: counts.done + counts['not-applicable'], pending: 0, unverifiable: counts.unverifiable, suppressed: params.getSuppressed?.() ?? 0 }, extraPassCount };
  }

  private isRoundStalled(
    params: PlanStepVerificationRunParams, round: number, pendingCount: number, pendingHistory: number[],
  ): boolean {
    if (!params.refreshSteps) return round === params.stallWindow;
    return this.recordPendingAndCheckStall(pendingHistory, pendingCount, params.stallWindow);
  }

  private resolvePendingRound(
    statusMap: Map<number, StepAssessment>, nowPending: StepAssessment[], round: number,
    params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number, pendingHistory: number[],
  ): PlanStepVerificationOutcome {
    const pending = nowPending.length, reason = sessionId
      ? `step-verify.stalled pending=${pending} window=${JSON.stringify(pendingHistory)}`
      : `step-verify.skipped reason=provider-session-unavailable pending=${pending}`;
    this.logEventAndAppendToLogFile('WARN', reason, params.silent);
    this.logMissedSteps(nowPending, params.silent);
    const counts = countStatuses(statusMap.values());
    return { sessionId, summary: { rounds: round, done: counts.done + counts['not-applicable'], pending, unverifiable: counts.unverifiable, suppressed: params.getSuppressed?.() ?? 0 }, extraPassCount };
  }

  private recordPendingAndCheckStall(history: number[], pendingCount: number, window: number): boolean {
    history.push(pendingCount);
    if (history.length > window) history.shift();
    if (history.length < window) return false;
    return history[window - 1] >= history[0];
  }

  private logMissedSteps(nowPending: StepAssessment[], silent?: boolean): void {
    for (const p of nowPending) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.missed index=${p.index} status=${p.status} missing=${p.missing ?? 'n/a'}`, silent);
    }
  }

  private async assessSteps(
    params: PlanStepVerificationRunParams, steps: AssessableStep[],
  ): Promise<{ steps: Map<number, StepAssessment> | undefined; failureCause?: string }> {
    let failureCause: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attemptAssessment(params, steps, c => {
        failureCause = c;
      });
      if (result) return { steps: result };
    }
    appendToLogFile('ERROR', 'step-verify.assess.invalid', 'step-verification');
    return { steps: undefined, failureCause };
  }

  private handleAssessmentAttemptError(error: unknown, onFailureCause?: (cause: string) => void): undefined {
    if (isAiProviderErrorLike(error) && error.category === 'auth') throw error;
    const cause = error instanceof Error ? error.message : String(error);
    onFailureCause?.(cause);
    appendToLogFile('ERROR', `step-verify.assess.attempt-failed cause=${cause}`, 'step-verification');
    return undefined;
  }

  private async attemptAssessment(
    params: PlanStepVerificationRunParams, steps: AssessableStep[],
    onFailureCause?: (cause: string) => void,
  ): Promise<Map<number, StepAssessment> | undefined> {
    return this.runSingleAssessmentAttempt(params, steps)
      .catch(error => this.handleAssessmentAttemptError(error, onFailureCause));
  }

  private async runSingleAssessmentAttempt(
    params: PlanStepVerificationRunParams, activeSteps: AssessableStep[],
  ): Promise<Map<number, StepAssessment>> {
    const statuses = params.mode === 'pull'
      ? await this.runPullAssessment(params, activeSteps)
      : await this.runPushAssessment(params, activeSteps);
    return this.reconcilePartialAssessments(statuses, activeSteps.map(step => step.index), params.silent);
  }

  private async runPullAssessment(
    params: PlanStepVerificationRunParams, activeSteps: AssessableStep[],
  ): Promise<StepAssessment[]> {
    return this.pullStepAssessor.assess({
      steps: stripRepoNamePrefix(activeSteps, params.repoDir),
      repoDir: params.repoDir,
      baseRef: params.baseRef ?? 'HEAD',
      provider: params.assessorProvider,
      model: params.assessorModel,
      ...(params.assessorBackend && { backend: params.assessorBackend }),
    });
  }

  private async runPushAssessment(
    params: PlanStepVerificationRunParams, activeSteps: AssessableStep[],
  ): Promise<StepAssessment[]> {
    const strippedSteps = stripRepoNamePrefix(activeSteps, params.repoDir);
    const evidence = await this.captureEvidence(params, strippedSteps);
    const executionEvidence = await this.collectExecutionEvidence(params);
    const prompt = buildStepAssessorPrompt(strippedSteps, evidence, executionEvidence);
    return this.requestPushAssessment(params, prompt);
  }

  private async requestPushAssessment(
    params: PlanStepVerificationRunParams, prompt: string,
  ): Promise<StepAssessment[]> {
    const response = await this.aiService.execute({
      prompt,
      systemPrompt: STEP_ASSESSOR_SYSTEM_PROMPT_WITH_SCHEMA,
      temperature: 0, maxTokens: 4096,
      stage: 'implement',
      structuredOutput: { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema },
      ...(params.assessorProvider && { provider: params.assessorProvider }),
      ...(params.assessorModel && { model: params.assessorModel }),
      ...(params.assessorBackend && { backend: params.assessorBackend }),
    });
    return stepAssessmentResponseSchema.parse(parseJsonResponse<unknown>(response.content)).statuses;
  }

  private reconcilePartialAssessments(
    statuses: StepAssessment[], expectedIndices: number[], silent?: boolean,
  ): Map<number, StepAssessment> {
    const { assessments, droppedIndices } = partitionAssessments(statuses, expectedIndices);
    const missingIndices = expectedIndices.filter(index => !assessments.has(index));
    this.logReconciliationAnomalies(missingIndices, droppedIndices, silent);
    for (const index of missingIndices) {
      assessments.set(index, buildUnassessedFallback(index));
    }
    return assessments;
  }

  private logReconciliationAnomalies(missingIndices: number[], droppedIndices: number[], silent?: boolean): void {
    for (const index of missingIndices) this.logReconciliationAnomaly(`missing-index=${index}`, silent);
    for (const index of droppedIndices) this.logReconciliationAnomaly(`dropped-index=${index}`, silent);
  }

  private logReconciliationAnomaly(anomaly: string, silent?: boolean): void {
    this.logEventAndAppendToLogFile('WARN', `step-verify.assess.partial ${anomaly}`, silent);
  }

  private logAssessmentSummary(
    statusMap: Map<number, StepAssessment>,
    counts: Record<string, number>,
    silent?: boolean,
  ): void {
    this.logEventAndAppendToLogFile(
      'INFO',
      `step-verify.assessed steps=${statusMap.size} done=${counts.done} not-applicable=${counts['not-applicable']} unverifiable=${counts.unverifiable} partially-done=${counts['partially-done']} not-done=${counts['not-done']}`,
      silent,
    );
  }

  private logPendingStatuses(
    statusMap: Map<number, StepAssessment>, silent?: boolean,
  ): Map<number, StepAssessment> {
    const counts = countStatuses(statusMap.values());
    for (const [, s] of statusMap) {
      if (s.status !== 'done' && s.status !== 'not-applicable') {
        this.logEventAndAppendToLogFile('INFO', `step-verify.status index=${s.index} status=${s.status} missing=${s.missing ?? 'n/a'}`, silent);
      }
    }
    this.logAssessmentSummary(statusMap, counts, silent);
    return statusMap;
  }

  private async captureEvidence(
    params: PlanStepVerificationRunParams, strippedSteps: AssessableStep[],
  ): Promise<PushEvidence> {
    const untrackedSections = await this.collectUntrackedSections(params.repoDir);
    const evidence = await collectPushEvidence({
      repoDir: params.repoDir,
      baseRef: params.baseRef ?? 'HEAD',
      stepTexts: strippedSteps.map(step => step.text),
      untrackedSections,
    });
    this.logEvidenceGaps(evidence, params.silent);
    return evidence;
  }

  private logEvidenceGaps(evidence: PushEvidence, silent?: boolean): void {
    if (evidence.omittedPaths.length) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.diff.omitted paths=${evidence.omittedPaths.join(',')}`, silent);
    }
    if (evidence.truncatedUntrackedPaths.length) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.diff.truncated untracked-truncated=${evidence.truncatedUntrackedPaths.join(',')}`, silent);
    }
  }

  private async collectStagedFiles(repoDir: string): Promise<string[]> {
    const status = await this.gitService.getStatus(repoDir);
    return (status as { staged?: string[] }).staged ?? [];
  }

  private async collectExecutionEvidence(
    params: PlanStepVerificationRunParams,
  ): Promise<ExecutionEvidence | undefined> {
    if (!params.verificationOutcomes?.length && !params.commitPolicy) return undefined;
    const stagedFiles = await this.collectStagedFiles(params.repoDir);
    const commitsSinceBaseline = await countCommitsSinceBaseline(params.repoDir, params.baseRef);
    return {
      outcomes: params.verificationOutcomes ?? [],
      ...(params.commitPolicy && { commitPolicy: params.commitPolicy }),
      stagedFiles,
      ...(commitsSinceBaseline !== undefined && { commitsSinceBaseline }),
    };
  }

  private async collectUntrackedSections(repoDir: string): Promise<string[]> {
    const status = await this.gitService.getStatus(repoDir);
    const untrackedFiles: string[] = (status as { not_added?: string[] }).not_added ?? [];
    const sections: string[] = [];
    for (const file of untrackedFiles) {
      const [section] = executeWithCatch({
        fn: () => `### ${file}\n\`\`\`\n${fs.readFileSync(path.resolve(repoDir, file), 'utf-8')}\n\`\`\``,
        onError: () => { appendToLogFile('DEBUG', `step-verify.untracked.unreadable path=${file}`, 'step-verification'); },
      });
      if (section !== undefined) sections.push(section);
    }
    return sections;
  }

  logSkip(reason: string, silent?: boolean): void {
    this.logEventAndAppendToLogFile('INFO', `step-verify.skipped reason=${reason}`, silent);
  }

  private logEventAndAppendToLogFile(level: string, message: string, silent?: boolean): void {
    appendToLogFile(level, message, 'step-verification');
    if (!silent) this.presenter.progress(`  [step-verify] ${message}`);
  }
}
