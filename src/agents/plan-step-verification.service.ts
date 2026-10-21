import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { needleSearchReminder } from '../integrations/ai/prompt-fragments';
import { planProblemInstruction } from '../integrations/ai/adapters/shared-routing';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../common/presentation/cli-presenter.service';
import { appendToLogFile } from '../common/logger/log-file-writer';
import { stepAssessmentResponseJsonSchema, stepAssessmentResponseSchema } from '../common/schemas/step-verification.schema';
import type { PlanComplexity } from '../common/types/ai.types';
import type { StepAssessment, StepVerificationSummary } from '../common/types/step-verification.types';
import { ApiError, ConfigurationError, ERROR_CODE } from '../common/errors/app.error';
import { isAiProviderErrorLike } from '../common/utils/errors';
import { mentionsPath } from '../common/utils/mentions-path';
import type { WfAiProviderName, WfBackendMode, WfStepVerificationMode } from '../common/types/config.types';
import { PullStepAssessorService, type PullStepAssessmentParams } from './pull-step-assessor.service';
import type { AssessableStep } from './step-spec-fidelity.service';
import { executeAsyncWithCatch, executeWithCatch } from '../common/utils/execute-with-catch';
import type { VerificationOutcome } from '../common/types/agent.types';
import type { CommitPolicy } from '../common/utils/implement-commit-policy';
import {
  EVIDENCE_CEILING_CHARS,
  EVIDENCE_FLOOR_CHARS,
  allocateEvidence,
  buildEvidenceCompletenessSection,
  computeEvidenceBudget,
  gapAwareStatusRules,
  hasEvidenceGaps,
  partitionStepsForPhasedAssessment,
  type EvidenceBudgetReport,
  type EvidenceSection,
} from './plan-step-evidence-budget';

export { EVIDENCE_CEILING_CHARS, EVIDENCE_FLOOR_CHARS } from './plan-step-evidence-budget';

const execFileAsync = promisify(execFile);
const FETCH_CEILING_CHARS = 3 * EVIDENCE_CEILING_CHARS;
const OVERSIZE_PROMPT_CHARS = 300_000;
const NUL_SNIFF_BYTES = 8_192;
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

const commandEvidenceRules = [
  '## Command evidence rules',
  '- Matched command step with passed outcome: mark done',
  '- Matched command step with failed outcome: mark not-done (cite the failure output as what is missing)',
  '- Command step matched to a skipped outcome or with no matching entry: mark not-applicable',
  '- Stage-and-commit step with a blocked commit policy and staged or working-tree changes: mark done'
  + ' — the implement stage intentionally leaves work staged; this satisfies the step',
  '- Never mark a policy-blocked commit step as not-done or unverifiable',
  '- Hand-off step (run lint or smokes, check git status or git diff --cached, commit or PR message wording):'
  + ' judge only the parts the evidence shows; parts backed by a matched passed outcome count as done',
  '- Unregistered commands, git-state checks, and commit or PR message or trailer wording that the evidence'
  + ' cannot show: mark not-applicable, not partially-done',
];

const verificationPromptFooter = [
  '',
  'Address ONLY the steps listed above. Read the relevant files first, then apply edits to complete each step fully.',
  needleSearchReminder,
  'After all edits are complete, run each verification command exactly as written.',
  planProblemInstruction,
  [
    'If a step shows [IMPLEMENTER REPORTED PLAN PROBLEM], do not force exact conformance;',
    'keep the alternative when it satisfies the step purpose and confirm or revise the report in the final message.',
  ].join(' '),
  [
    'If a step needs no change because the named file or pattern is already absent, answer with a single-line proof',
    '(for example the grep command and its empty result) plus NO-CHANGE: <path> instead of re-reading files.',
  ].join(' '),
  'Do not output any text or plan before making your first tool call.',
];

export type PushEvidence = {
  nameStatus: string;
  fileDiffSections: string[];
  untrackedSections: string[];
  budgetReport: EvidenceBudgetReport;
  sections: EvidenceSection[];
};

export type UntrackedFile = { path: string; content: string; binary?: boolean };

export type ExecutionEvidence = {
  outcomes: VerificationOutcome[];
  commitPolicy?: CommitPolicy;
  stagedFiles: string[];
  commitsSinceBaseline?: number;
};

type PushEvidenceParams = {
  repoDir: string;
  baseRef: string;
  stepTexts: string[];
  affectedFiles?: string[];
  untrackedFiles?: UntrackedFile[];
};

type EvidenceCandidate = { path: string; mentioned: boolean; untracked?: UntrackedFile };

const runGitDiff = async (repoDir: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['diff', ...args], { cwd: repoDir, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
};

const parseChangedPaths = (nameStatus: string): string[] => nameStatus
  .split('\n')
  .filter(Boolean)
  .map(line => line.split('\t').at(-1) ?? '')
  .filter(Boolean);

const buildEvidenceCandidates = (
  params: PushEvidenceParams, trackedPaths: string[], untracked: UntrackedFile[],
): EvidenceCandidate[] => {
  const stepText = params.stepTexts.join('\n');
  const affected = new Set(params.affectedFiles ?? []);
  const isMentioned = (filePath: string): boolean => mentionsPath(stepText, filePath) || affected.has(filePath);
  const candidates: EvidenceCandidate[] = [
    ...trackedPaths.map(filePath => ({ path: filePath, mentioned: isMentioned(filePath) })),
    ...untracked.map(file => ({ path: file.path, mentioned: isMentioned(file.path), untracked: file })),
  ];
  return [...candidates.filter(c => c.mentioned), ...candidates.filter(c => !c.mentioned)];
};

const fetchEvidenceSection = async (
  params: PushEvidenceParams, candidate: EvidenceCandidate,
): Promise<EvidenceSection> => {
  if (candidate.untracked) {
    const { path: filePath, content, binary } = candidate.untracked;
    return { path: filePath, kind: 'untracked', content, binary, mentioned: candidate.mentioned };
  }
  const content = await runGitDiff(params.repoDir, [params.baseRef, '--', candidate.path]);
  return { path: candidate.path, kind: 'tracked', content, mentioned: candidate.mentioned };
};

type FetchedEvidence = { sections: EvidenceSection[]; unfetched: string[] };

const fetchEvidenceSections = async (
  params: PushEvidenceParams, trackedPaths: string[], untracked: UntrackedFile[],
): Promise<FetchedEvidence> => {
  const fetched: FetchedEvidence = { sections: [], unfetched: [] };
  let fetchedChars = 0;
  for (const candidate of buildEvidenceCandidates(params, trackedPaths, untracked)) {
    const exhausted = fetchedChars >= FETCH_CEILING_CHARS;
    const section = exhausted ? undefined : await fetchEvidenceSection(params, candidate);
    if (section) fetched.sections.push(section);
    else fetched.unfetched.push(candidate.path);
    fetchedChars += section?.content.length ?? 0;
  }
  return fetched;
};

const renderSectionsOfKind = (
  sections: EvidenceSection[], rendered: Map<string, string>, kind: EvidenceSection['kind'],
): string[] => sections.filter(s => s.kind === kind && rendered.has(s.path)).map(s => rendered.get(s.path) ?? '');

const buildPushEvidence = (nameStatus: string, sections: EvidenceSection[], unfetched: string[]): PushEvidence => {
  const measuredTotal = sections.filter(s => !s.binary).reduce((sum, s) => sum + s.content.length, 0);
  const budget = computeEvidenceBudget({
    measuredTotal, nameStatusLength: nameStatus.length, floor: EVIDENCE_FLOOR_CHARS, ceiling: EVIDENCE_CEILING_CHARS,
  });
  const { rendered, report } = allocateEvidence(sections, budget);
  return {
    nameStatus,
    fileDiffSections: renderSectionsOfKind(sections, rendered, 'tracked'),
    untrackedSections: renderSectionsOfKind(sections, rendered, 'untracked'),
    budgetReport: { ...report, omitted: [...report.omitted, ...unfetched] },
    sections,
  };
};

export const collectPushEvidence = async (params: PushEvidenceParams): Promise<PushEvidence> => {
  const nameStatus = await runGitDiff(params.repoDir, ['--name-status', params.baseRef]);
  const { sections, unfetched } = await fetchEvidenceSections(
    params, parseChangedPaths(nameStatus), params.untrackedFiles ?? [],
  );
  return buildPushEvidence(nameStatus, sections, unfetched);
};

const readUntrackedFile = (repoDir: string, file: string): UntrackedFile => {
  const buffer = fs.readFileSync(path.resolve(repoDir, file));
  const binary = buffer.subarray(0, NUL_SNIFF_BYTES).includes(0);
  const content = binary ? `[binary file, ${buffer.length} bytes]` : buffer.toString('utf-8');
  return { path: file, content, binary };
};

const buildGroupEvidence = (
  evidence: PushEvidence, sections: EvidenceSection[], uncoveredPaths: string[],
): PushEvidence => {
  const fetchedPaths = new Set(evidence.sections.map(s => s.path));
  const unfetched = evidence.budgetReport.omitted.filter(p => !fetchedPaths.has(p));
  return buildPushEvidence(evidence.nameStatus, sections, [...unfetched, ...uncoveredPaths]);
};

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

export type StepVerificationModeDirective
  = | { source: 'user'; mode: WfStepVerificationMode }
    | { source: 'auto'; complexity: PlanComplexity; pullSupported: boolean };

type EvidenceSeed = { evidence?: PushEvidence };

type SeedableRunParams = PlanStepVerificationRunParams & { evidenceSeed?: EvidenceSeed };

type ResolvedRunParams = SeedableRunParams & { mode: WfStepVerificationMode };

type ResolvedMode = { mode: WfStepVerificationMode; reason: string; measuredEvidence?: PushEvidence };

type MeasuredEvidence = { evidence: PushEvidence; executionEvidence?: ExecutionEvidence };

export interface PlanStepVerificationRunParams {
  steps: string[];
  planSummary: string;
  repoDir: string;
  affectedFiles?: string[];
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
  modeDirective?: StepVerificationModeDirective;
  assessorProvider?: WfAiProviderName;
  assessorModel?: string;
  assessorBackend?: WfBackendMode;
  sessionId: string;
  stallWindow: number;
  silent?: boolean;
  planStepNumbers?: number[];
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
export const stripRepoPrefix = (text: string, repoDir: string): string => {
  const repoName = path.basename(repoDir);
  if (!repoName) return text;
  return text.split(`${repoName}/`).join('');
};

export const stripRepoNamePrefix = (steps: AssessableStep[], repoDir: string): AssessableStep[] =>
  steps.map(step => ({ ...step, text: stripRepoPrefix(step.text, repoDir) }));

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
    ...(section ? [section, ''] : []), ...gapAwareStatusRules(evidence.budgetReport, steps.map(step => step.index)),
    ...(section ? commandEvidenceRules : []),
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
  buildUntrackedEvidenceNote(evidence.untrackedSections),
  buildEvidenceCompletenessSection(evidence.budgetReport),
  '',
].join('\n');
const buildUntrackedEvidenceNote = (sections: string[]): string => sections.length ? `\n\n## Untracked new files\n\n${sections.join('\n\n')}` : '';

type FixPromptArgs = {
  pending: StepAssessment[];
  round: number;
  stallWindow?: number;
  stepTexts: Map<number, string>;
  planStepNumbers?: number[];
};

const formatPlanStepSuffix = (planStepNumber: number | undefined): string =>
  planStepNumber === undefined ? '' : ` - plan step ${planStepNumber}`;

export const buildPlanStepVerificationPrompt = (args: FixPromptArgs): string => {
  const { pending, round, stallWindow, stepTexts, planStepNumbers } = args;
  const stallWindowTag = stallWindow === undefined ? '' : ` (stall window: ${stallWindow})`;
  const roundHeader = `Verification round ${round}${stallWindowTag}: a post-implementation audit found plan steps that are not fully implemented.`;
  const stepLines = pending.flatMap(step => [
    `Step ${step.index} (${step.status})${formatPlanStepSuffix(planStepNumbers?.[step.index])}`,
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

const buildZeroAcceptedError = (expectedIndices: number[], droppedIndices: number[]): ApiError => new ApiError(
  ERROR_CODE.AI_PROVIDER_ERROR,
  `Assessor response accepted zero of ${expectedIndices.length} expected step indices`,
  undefined, undefined, { expectedIndices, droppedIndices }, true,
);

const buildUnassessedFallback = (index: number): StepAssessment => ({
  index,
  status: 'not-done',
  missing: 'Not assessed in this round; assessor response omitted this index.',
});

const normalizeCoveragePath = (file: string, repoDir: string): string => {
  const withoutDotSlash = file.trim().replace(/^(?:\.\/)+/, '');
  const prefix = [`${repoDir}/`, `${path.basename(repoDir)}/`].find(candidate => withoutDotSlash.startsWith(candidate));
  return prefix ? withoutDotSlash.slice(prefix.length) : withoutDotSlash;
};

const buildPullAssessorTarget = (
  params: PlanStepVerificationRunParams,
): Pick<PullStepAssessmentParams, 'provider' | 'model' | 'backend'> => ({
  provider: params.assessorProvider,
  model: params.assessorModel,
  ...(params.assessorBackend && { backend: params.assessorBackend }),
});

const findUninspectedPaths = (checklist: string[], inspectedPaths: string[], repoDir: string): string[] => {
  if (checklist.length && !inspectedPaths.length) {
    throw new Error(`Pull assessor reported no inspectedPaths for a checklist of ${checklist.length} files`);
  }
  const inspected = new Set(inspectedPaths.map(file => normalizeCoveragePath(file, repoDir)));
  return checklist.map(file => normalizeCoveragePath(file, repoDir)).filter(file => !inspected.has(file));
};

const downgradeIfUncovered = (status: StepAssessment, stepText: string, uncovered: string[]): StepAssessment => {
  if (status.status !== 'done' && status.status !== 'not-applicable') return status;
  const mentioned = uncovered.filter(file => mentionsPath(stepText, file));
  if (!mentioned.length) return status;
  return { index: status.index, status: 'unverifiable', missing: `Assessor did not inspect ${mentioned.join(', ')}` };
};

export const applyPullCoverageDowngrades = (args: {
  statuses: StepAssessment[];
  steps: AssessableStep[];
  uncoveredPaths: string[];
  repoDir: string;
}): StepAssessment[] => {
  const uncovered = args.uncoveredPaths.map(file => normalizeCoveragePath(file, args.repoDir));
  const textByIndex = new Map(args.steps.map(step => [step.index, step.text]));
  return args.statuses.map(status => downgradeIfUncovered(status, textByIndex.get(status.index) ?? '', uncovered));
};

@Injectable()
export class PlanStepVerificationService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
    private readonly presenter: CliPresenter,
    private readonly pullStepAssessor: PullStepAssessorService,
  ) {}

  async run(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    const { mode, reason, measuredEvidence } = await this.resolveEffectiveMode(params);
    this.logEventAndAppendToLogFile('INFO', `step-verify.mode=${mode} (${reason})`, params.silent);
    const resolved: ResolvedRunParams = { ...params, mode, evidenceSeed: { evidence: measuredEvidence } };
    const [outcome] = await executeAsyncWithCatch({
      fn: () => this.runVerificationLoop(resolved),
      rethrowIf: error => isAiProviderErrorLike(error) && error.category === 'auth',
      onError: error => {
        const cause = error instanceof Error ? error.message : String(error);
        this.logEventAndAppendToLogFile('ERROR', `step-verify.error cause=${cause}`, params.silent);
        return { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
      },
    });
    return outcome ?? { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
  }

  private async resolveEffectiveMode(params: PlanStepVerificationRunParams): Promise<ResolvedMode> {
    const directive = params.modeDirective;
    if (!directive) return { mode: 'push', reason: 'default' };
    if (directive.source === 'user') return { mode: directive.mode, reason: 'user override' };
    if (!directive.pullSupported) return { mode: 'push', reason: 'auto — pull assessor provider unsupported' };
    if (directive.complexity === 'high') return { mode: 'pull', reason: 'auto — high complexity' };
    if (directive.complexity === 'low') return { mode: 'push', reason: 'auto — low complexity' };
    return this.routeMediumByMeasuredEvidence(params);
  }

  private async routeMediumByMeasuredEvidence(params: PlanStepVerificationRunParams): Promise<ResolvedMode> {
    const steps = params.steps.map((text, index) => ({ index, text }));
    const [evidence, failure] = await executeAsyncWithCatch({
      fn: () => this.captureEvidence(params, stripRepoNamePrefix(steps, params.repoDir)),
      onError: error => error instanceof Error ? error.message : String(error),
    });
    if (!evidence) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.mode.measure-failed cause=${failure}`, params.silent);
      return { mode: 'push', reason: `auto — medium complexity, evidence measurement failed: ${failure}` };
    }
    return hasEvidenceGaps(evidence.budgetReport)
      ? { mode: 'pull', reason: 'auto — medium complexity, evidence exceeds push budget', measuredEvidence: evidence }
      : { mode: 'push', reason: 'auto — medium complexity, evidence fits push budget', measuredEvidence: evidence };
  }

  private async runVerificationLoop(params: ResolvedRunParams): Promise<PlanStepVerificationOutcome> {
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
    state: VerificationLoopState, params: ResolvedRunParams,
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
    count: number, params: ResolvedRunParams,
    sessionId: string | undefined, extraPassCount: number, failureCause?: string,
  ): PlanStepVerificationOutcome | null {
    if (!params.refreshSteps || count < params.stallWindow) return null;
    const causeTag = failureCause ? ` cause=${failureCause}` : '';
    this.logEventAndAppendToLogFile('WARN', `step-verify.exhausted reason=assessor-failed-${count}-rounds-in-a-row${causeTag} stallWindow=${params.stallWindow}`, params.silent);
    return { sessionId, summary: undefined, extraPassCount };
  }

  private async runOneRound(
    params: ResolvedRunParams,
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
    params: ResolvedRunParams, round: number, sessionId: string | undefined,
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
    params: ResolvedRunParams,
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
    params: ResolvedRunParams, pending: StepAssessment[], round: number,
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

  private logRoundStart(params: ResolvedRunParams, round: number): void {
    const roundLabel = params.refreshSteps ? `${round}/?` : `${round}/${params.stallWindow}`;
    this.logEventAndAppendToLogFile('INFO', `step-verify.round.start round=${roundLabel} stallWindow=${params.stallWindow}`, params.silent);
  }

  private buildFixPrompt(
    nowPending: StepAssessment[], round: number, params: ResolvedRunParams, stepTexts: Map<number, string>,
  ): string {
    return buildPlanStepVerificationPrompt({
      pending: nowPending,
      round,
      stallWindow: params.refreshSteps ? undefined : params.stallWindow,
      stepTexts,
      planStepNumbers: params.planStepNumbers,
    });
  }

  private finalizeRound(
    outcome: PlanStepVerificationOutcome | null, sessionId: string | undefined, extraPassCount: number,
  ): RoundResult {
    return { outcome: outcome ?? { sessionId, summary: undefined, extraPassCount }, extraPassCount };
  }

  private handleAssessmentFailure(
    round: number, params: ResolvedRunParams, sessionId: string | undefined, extraPassCount: number,
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
    params: ResolvedRunParams,
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
    statusMap: Map<number, StepAssessment>, round: number, params: ResolvedRunParams,
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
    params: ResolvedRunParams, round: number, pendingCount: number, pendingHistory: number[],
  ): boolean {
    if (!params.refreshSteps) return round === params.stallWindow;
    return this.recordPendingAndCheckStall(pendingHistory, pendingCount, params.stallWindow);
  }

  private resolvePendingRound(
    statusMap: Map<number, StepAssessment>, nowPending: StepAssessment[], round: number,
    params: ResolvedRunParams,
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
    params: ResolvedRunParams, steps: AssessableStep[],
  ): Promise<{ steps: Map<number, StepAssessment> | undefined; failureCause?: string }> {
    const strippedSteps = stripRepoNamePrefix(steps, params.repoDir);
    const measure = this.createRoundMeasurer(params, strippedSteps);
    let failureCause: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attemptAssessment(params, strippedSteps, measure, c => {
        failureCause = c;
      });
      if (result) return { steps: result };
    }
    appendToLogFile('ERROR', 'step-verify.assess.invalid', 'step-verification');
    return { steps: undefined, failureCause };
  }

  private createRoundMeasurer(
    params: ResolvedRunParams, strippedSteps: AssessableStep[],
  ): () => Promise<MeasuredEvidence> {
    let measured: MeasuredEvidence | undefined;
    return async () => {
      measured ??= {
        evidence: await this.captureEvidence(params, strippedSteps),
        executionEvidence: await this.collectExecutionEvidence(params),
      };
      return measured;
    };
  }

  private handleAssessmentAttemptError(error: unknown, onFailureCause?: (cause: string) => void): undefined {
    if (isAiProviderErrorLike(error) && error.category === 'auth') throw error;
    if (error instanceof ConfigurationError) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    onFailureCause?.(cause);
    appendToLogFile('ERROR', `step-verify.assess.attempt-failed cause=${cause}`, 'step-verification');
    return undefined;
  }

  private async attemptAssessment(
    params: ResolvedRunParams, strippedSteps: AssessableStep[], measure: () => Promise<MeasuredEvidence>,
    onFailureCause?: (cause: string) => void,
  ): Promise<Map<number, StepAssessment> | undefined> {
    return measure()
      .then(measured => this.runSingleAssessmentAttempt(params, { strippedSteps, ...measured }))
      .catch(error => this.handleAssessmentAttemptError(error, onFailureCause));
  }

  private async runSingleAssessmentAttempt(
    params: ResolvedRunParams,
    { strippedSteps, evidence, executionEvidence }: MeasuredEvidence & { strippedSteps: AssessableStep[] },
  ): Promise<Map<number, StepAssessment>> {
    const statuses = params.mode === 'pull'
      ? await this.runPullAssessment(params, strippedSteps, evidence, executionEvidence)
      : await this.runPushAssessment(params, strippedSteps, evidence, executionEvidence);
    return this.reconcilePartialAssessments(statuses, strippedSteps.map(step => step.index), params.silent);
  }

  private async runPullAssessment(
    params: ResolvedRunParams, strippedSteps: AssessableStep[], evidence: PushEvidence,
    executionEvidence?: ExecutionEvidence,
  ): Promise<StepAssessment[]> {
    const changedPaths = parseChangedPaths(evidence.nameStatus);
    const untrackedPaths = evidence.sections.filter(s => s.kind === 'untracked').map(s => s.path);
    const { statuses, inspectedPaths } = await this.pullStepAssessor.assess(
      this.buildPullAssessmentParams(params, strippedSteps, { changedPaths, untrackedPaths, executionEvidence }),
    );
    const uncoveredPaths = findUninspectedPaths([...changedPaths, ...untrackedPaths], inspectedPaths, params.repoDir);
    return this.enforcePullCoverage(params, strippedSteps, statuses, uncoveredPaths);
  }

  private buildPullAssessmentParams(
    params: ResolvedRunParams, strippedSteps: AssessableStep[],
    checklist: { changedPaths: string[]; untrackedPaths: string[]; executionEvidence?: ExecutionEvidence },
  ): PullStepAssessmentParams {
    const executionEvidenceSection = buildExecutionEvidenceSection(checklist.executionEvidence);
    return {
      steps: strippedSteps,
      repoDir: params.repoDir,
      baseRef: params.baseRef ?? 'HEAD',
      changedPaths: checklist.changedPaths,
      untrackedPaths: checklist.untrackedPaths,
      ...(executionEvidenceSection && { executionEvidenceSection }),
      ...buildPullAssessorTarget(params),
    };
  }

  private enforcePullCoverage(
    params: ResolvedRunParams, steps: AssessableStep[], statuses: StepAssessment[], uncoveredPaths: string[],
  ): StepAssessment[] {
    const downgraded = applyPullCoverageDowngrades({ statuses, steps, uncoveredPaths, repoDir: params.repoDir });
    const indices = downgraded.filter((status, i) => status !== statuses[i]).map(status => status.index);
    if (indices.length) this.logCoverageGap(params, { steps, indices, uncoveredPaths });
    return downgraded;
  }

  private logCoverageGap(
    params: ResolvedRunParams, gap: { steps: AssessableStep[]; indices: number[]; uncoveredPaths: string[] },
  ): void {
    const downgradedText = gap.steps.filter(step => gap.indices.includes(step.index)).map(step => step.text).join('\n');
    const paths = gap.uncoveredPaths.filter(file => mentionsPath(downgradedText, file));
    this.logEventAndAppendToLogFile(
      'WARN', `step-verify.pull.coverage-gap indices=${gap.indices.join(',')} paths=${paths.join(',')}`, params.silent,
    );
  }

  private async runPushAssessment(
    params: ResolvedRunParams, strippedSteps: AssessableStep[], evidence: PushEvidence,
    executionEvidence?: ExecutionEvidence,
  ): Promise<StepAssessment[]> {
    const statuses: StepAssessment[] = [];
    for (const group of this.planAssessmentGroups(params, strippedSteps, evidence)) {
      statuses.push(...await this.assessGroup(params, group, executionEvidence));
    }
    return statuses;
  }

  private planAssessmentGroups(
    params: PlanStepVerificationRunParams, steps: AssessableStep[], evidence: PushEvidence,
  ): { steps: AssessableStep[]; evidence: PushEvidence }[] {
    const groupBudget = EVIDENCE_CEILING_CHARS - evidence.nameStatus.length;
    const fitsWhole = evidence.budgetReport.totalMeasured <= groupBudget;
    if (fitsWhole || groupBudget < EVIDENCE_FLOOR_CHARS) return [{ steps, evidence }];
    const groups = partitionStepsForPhasedAssessment(steps, evidence.sections, groupBudget);
    if (groups.length > 1) {
      this.logEventAndAppendToLogFile('INFO', `step-verify.assess.phased groups=${groups.length}`, params.silent);
    }
    const uncovered = this.findUncoveredPaths(evidence, groups);
    return groups.map(group => ({
      steps: group.steps, evidence: buildGroupEvidence(evidence, group.sections, uncovered),
    }));
  }

  private findUncoveredPaths(evidence: PushEvidence, groups: { sections: EvidenceSection[] }[]): string[] {
    const covered = new Set(groups.flatMap(group => group.sections.map(s => s.path)));
    return evidence.sections.filter(s => !s.binary && !covered.has(s.path)).map(s => s.path);
  }

  private async assessGroup(
    params: ResolvedRunParams,
    group: { steps: AssessableStep[]; evidence: PushEvidence },
    executionEvidence?: ExecutionEvidence,
  ): Promise<StepAssessment[]> {
    const prompt = buildStepAssessorPrompt(group.steps, group.evidence, executionEvidence);
    this.logEvidenceGaps(group.evidence.budgetReport, params.silent);
    if (prompt.length > OVERSIZE_PROMPT_CHARS) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.prompt.oversize chars=${prompt.length}`, params.silent);
    }
    const statuses = await this.requestPushAssessment(params, prompt);
    this.assertGroupIndicesInScope(statuses, group.steps.map(step => step.index));
    this.logUnverifiableEvidenceGap(statuses, group.evidence.budgetReport, params.silent);
    return statuses;
  }

  private assertGroupIndicesInScope(statuses: StepAssessment[], expectedIndices: number[]): void {
    const expected = new Set(expectedIndices);
    const returnedIndices = statuses.map(status => status.index);
    const outOfScope = returnedIndices.filter(index => !expected.has(index));
    const coversAny = returnedIndices.some(index => expected.has(index));
    if (coversAny && !outOfScope.length) return;
    throw new Error(
      `Assessor returned indices [${returnedIndices.join(',')}] but expected [${expectedIndices.join(',')}]`,
    );
  }

  private logUnverifiableEvidenceGap(
    statuses: StepAssessment[], report: EvidenceBudgetReport, silent?: boolean,
  ): void {
    const indices = statuses.filter(s => s.status === 'unverifiable').map(s => s.index);
    if (!hasEvidenceGaps(report) || !indices.length) return;
    const paths = [...report.truncated.map(t => t.path), ...report.omitted];
    this.logEventAndAppendToLogFile(
      'WARN', `step-verify.unverifiable.evidence-gap indices=${indices.join(',')} paths=${paths.join(',')}`, silent,
    );
  }

  private async requestPushAssessment(
    params: ResolvedRunParams, prompt: string,
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
    if (expectedIndices.length && !assessments.size) {
      throw buildZeroAcceptedError(expectedIndices, droppedIndices);
    }
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
    params: SeedableRunParams, strippedSteps: AssessableStep[],
  ): Promise<PushEvidence> {
    const seeded = this.consumeEvidenceSeed(params);
    if (seeded) return seeded;
    const evidence = await collectPushEvidence({
      repoDir: params.repoDir,
      baseRef: params.baseRef ?? 'HEAD',
      stepTexts: strippedSteps.map(step => step.text),
      affectedFiles: params.affectedFiles?.map(file => stripRepoPrefix(file, params.repoDir)),
      untrackedFiles: await this.collectUntrackedFiles(params.repoDir),
    });
    this.logEvidenceBudget(evidence, params.silent);
    return evidence;
  }

  private consumeEvidenceSeed(params: SeedableRunParams): PushEvidence | undefined {
    const seed = params.evidenceSeed;
    const evidence = seed?.evidence;
    if (seed) seed.evidence = undefined;
    return evidence;
  }

  private logEvidenceBudget(evidence: PushEvidence, silent?: boolean): void {
    const untracked = evidence.sections.filter(s => s.kind === 'untracked').length;
    const files = evidence.sections.length - untracked;
    const { totalMeasured, budget } = evidence.budgetReport;
    this.logEventAndAppendToLogFile(
      'INFO', `step-verify.evidence.budget measured=${totalMeasured} budget=${budget} files=${files} untracked=${untracked}`,
      silent,
    );
  }

  private logEvidenceGaps(report: EvidenceBudgetReport, silent?: boolean): void {
    if (!hasEvidenceGaps(report)) return;
    this.logEventAndAppendToLogFile(
      'WARN', `step-verify.evidence.over-ceiling measured=${report.totalMeasured} budget=${report.budget}`, silent,
    );
    if (report.omitted.length) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.diff.omitted paths=${report.omitted.join(',')}`, silent);
    }
    if (report.truncated.length) {
      const paths = report.truncated.map(t => t.path).join(',');
      this.logEventAndAppendToLogFile('WARN', `step-verify.diff.truncated paths=${paths}`, silent);
    }
  }

  private async collectStagedFiles(repoDir: string): Promise<string[]> {
    const status = await this.gitService.getStatus(repoDir);
    return (status as { staged?: string[] }).staged ?? [];
  }

  private async collectExecutionEvidence(
    params: ResolvedRunParams,
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

  private async collectUntrackedFiles(repoDir: string): Promise<UntrackedFile[]> {
    const status = await this.gitService.getStatus(repoDir);
    const untrackedPaths: string[] = (status as { not_added?: string[] }).not_added ?? [];
    const files: UntrackedFile[] = [];
    for (const file of untrackedPaths) {
      const [untracked] = executeWithCatch({
        fn: () => readUntrackedFile(repoDir, file),
        onError: () => { appendToLogFile('DEBUG', `step-verify.untracked.unreadable path=${file}`, 'step-verification'); },
      });
      if (untracked !== undefined) files.push(untracked);
    }
    return files;
  }

  logSkip(reason: string, silent?: boolean): void {
    this.logEventAndAppendToLogFile('INFO', `step-verify.skipped reason=${reason}`, silent);
  }

  private logEventAndAppendToLogFile(level: string, message: string, silent?: boolean): void {
    appendToLogFile(level, message, 'step-verification');
    if (!silent) this.presenter.progress(`  [step-verify] ${message}`);
  }
}
