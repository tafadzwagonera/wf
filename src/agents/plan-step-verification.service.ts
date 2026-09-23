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

const execFileAsync = promisify(execFile);
const MAX_ASSESSOR_EVIDENCE_CHARS = 60_000;

const countStatuses = (statuses: Iterable<StepAssessment>): Record<StepAssessment['status'], number> => {
  const counts = { done: 0, 'not-applicable': 0, 'partially-done': 0, 'not-done': 0 };
  for (const status of statuses) counts[status.status]++;
  return counts;
};

const STEP_ASSESSOR_SYSTEM_PROMPT
  = 'You are a meticulous implementation auditor. Judge only from the evidence provided. Output ONLY valid JSON.';

const STEP_ASSESSOR_SYSTEM_PROMPT_WITH_SCHEMA
  = STEP_ASSESSOR_SYSTEM_PROMPT
    + '\n\nRespond with a JSON object matching this schema exactly:\n'
    + JSON.stringify(stepAssessmentResponseJsonSchema, null, 2);

const STEP_ASSESSOR_PREAMBLE = [
  STEP_ASSESSOR_SYSTEM_PROMPT,
  '',
  '## Steps to assess',
];

const STEP_ASSESSOR_RULES = [
  '## Status rules',
  '- done: fully implemented in the evidence',
  '- partially-done: started but incomplete (requires missing field)',
  '- not-done: not implemented at all (requires missing field)',
  '- not-applicable: step requires no code change or cannot be proven by a diff (e.g. run-the-tests steps, confirm-existing-behavior steps) — use instead of not-done for such steps',
  '',
  'Index each step ONLY by its [Plan step N] tag. A step\'s own text may contain other numbers '
  + '(e.g. an internal "Step N (RED)/(GREEN)" label) — those are part of that step\'s content, not separate steps to assess.',
  'Produce exactly one entry per [Plan step N] tag above — no more, no fewer — in this shape:',
  '{"statuses":[{"index":0,"status":"done"},{"index":1,"status":"partially-done","missing":"…"}]}',
  'Do not assume changes you cannot see.',
];

const VERIFICATION_PROMPT_FOOTER = [
  '',
  'Address ONLY the steps listed above. Read the relevant files first, then apply edits to complete each step fully.',
  'After all edits are complete, run each verification command exactly as written.',
  'Do not output any text or plan before making your first tool call.',
];

const findDuplicateOrOutOfRange = (statuses: StepAssessment[], stepCount: number): string | undefined => {
  const seen = new Set<number>();
  for (const s of statuses) {
    if (s.index < 0 || s.index >= stepCount) return `index ${s.index} out of range 0..${stepCount - 1}`;
    if (seen.has(s.index)) return `duplicate index ${s.index}`;
    seen.add(s.index);
  }
  return undefined;
};

const buildEvidenceText = (diff: string, untrackedSections: string[], truncated: boolean): string => {
  const untrackedBlock
    = untrackedSections.length > 0
      ? `\n\n## Untracked new files\n\n${untrackedSections.join('\n\n')}`
      : '';
  const evidenceNote = truncated
    ? '\n[Evidence was truncated. Apply conservative judgment — prefer not-done over done when unsure.]'
    : '';
  return diff + untrackedBlock + evidenceNote;
};

type RoundResult = {
  outcome?: PlanStepVerificationOutcome;
  sessionId?: string;
  extraPassCount: number;
  assessmentFailed?: boolean;
  assessmentFailureCause?: string;
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
  sessionId: string;
  stallWindow: number;
  silent?: boolean;
  runFixRound: (prompt: string, sessionId: string) => Promise<{ sessionId?: string; passCount?: number }>;
  /**
   * Called at the start of each assessment round to refresh the step list with
   * current spec-fidelity errors. When set, stall is detected by a rolling
   * pending-count history: the loop exits as stalled when the most-recent
   * pending count is no lower than the oldest count in the `stallWindow`-wide
   * window (i.e. no net improvement over the window). Must return a non-empty
   * string array — never null.
   */
  refreshSteps?: () => Promise<string[]>;
}

export interface PlanStepVerificationOutcome {
  sessionId?: string;
  summary?: StepVerificationSummary;
  extraPassCount: number;
}

export const validateStepAssessments = (
  statuses: StepAssessment[],
  stepCount: number,
): Map<number, StepAssessment> | string => {
  if (statuses.length !== stepCount) return `expected ${stepCount} assessments, got ${statuses.length}`;
  const error = findDuplicateOrOutOfRange(statuses, stepCount);
  if (error !== undefined) return error;
  const map = new Map<number, StepAssessment>();
  for (const s of statuses) map.set(s.index, s);
  return map;
};

/**
 * Plan steps carry repo-prefixed paths (e.g. `shop-v1.1/specs/plan.json`) to disambiguate
 * files across a multi-repo workspace listing, but `git diff` output is always relative to
 * the repo's own root (e.g. `specs/plan.json`). Left unstripped, the assessor LLM sees two
 * differently-spelled paths for the same file and can wrongly conclude the step's file was
 * never touched. Stripping the `repoDir` basename prefix here aligns both sides.
 */
export const stripRepoNamePrefix = (steps: string[], repoDir: string): string[] => {
  const repoName = path.basename(repoDir);
  if (!repoName) return steps;
  const prefix = `${repoName}/`;
  return steps.map(step => step.split(prefix).join(''));
};

export const buildStepAssessorPrompt = (
  steps: string[],
  diff: string,
  untrackedSections: string[],
  truncated: boolean,
): string => {
  const numbered = steps.map((s, i) => `[Plan step ${i}]\n${s}`).join('\n\n');
  const evidence = buildEvidenceText(diff, untrackedSections, truncated);
  const body = ['', '## Changed files diff', evidence, ''].join('\n');
  return [...STEP_ASSESSOR_PREAMBLE, numbered, body, ...STEP_ASSESSOR_RULES].join('\n');
};

export const buildPlanStepVerificationPrompt = (
  pending: StepAssessment[],
  round: number,
  stallWindow?: number,
): string => {
  const roundHeader = stallWindow === undefined
    ? `Verification round ${round}: a post-implementation audit found plan steps that are not fully implemented.`
    : `Verification round ${round} (stall window: ${stallWindow}): a post-implementation audit found plan steps that are not fully implemented.`;
  const lines: string[] = [roundHeader, ''];
  for (const p of pending) {
    lines.push(`Step ${p.index} (${p.status}): ${p.missing ?? ''}`);
    if (p.missing) lines.push(`Missing: ${p.missing}`);
  }
  return [...lines, ...VERIFICATION_PROMPT_FOOTER].join('\n');
};

@Injectable()
export class PlanStepVerificationService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
    private readonly presenter: CliPresenter,
  ) {}

  async run(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    try {
      return await this.runVerificationLoop(params);
    } catch (error) {
      if (isAiProviderErrorLike(error) && error.category === 'auth') throw error;
      const cause = error instanceof Error ? error.message : String(error);
      this.logEventAndAppendToLogFile('ERROR', `step-verify.error cause=${cause}`, params.silent);
      return { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
    }
  }

  private async runVerificationLoop(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    let state = this.createVerificationLoopState(params.sessionId);
    const pendingHistory: number[] = [];
    for (let round = 1; ; round += 1) {
      const result = await this.runOneRound(params, round, state.sessionId, state.extraPassCount, pendingHistory);
      if (result.outcome) return result.outcome;
      state = this.resolveNextLoopState(state, result);
      const stalled = this.checkConsecutiveFailureLimit(
        state.consecutiveFailures, params, state.sessionId, state.extraPassCount, state.lastFailureCause,
      );
      if (stalled) return stalled;
    }
  }

  private createVerificationLoopState(sessionId?: string): VerificationLoopState {
    return { sessionId, extraPassCount: 0, consecutiveFailures: 0 };
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
  ): Promise<RoundResult> {
    const activeSteps = params.refreshSteps ? await params.refreshSteps() : params.steps;
    return this.executeRound(params, round, sessionId, extraPassCount, activeSteps, pendingHistory);
  }

  private async executeRound(
    params: PlanStepVerificationRunParams,
    round: number, sessionId: string | undefined, extraPassCount: number, activeSteps: string[],
    pendingHistory: number[],
  ): Promise<RoundResult> {
    this.logRoundStart(params, round);
    const { steps: statusMap, failureCause } = await this.assessSteps({ ...params, steps: activeSteps });
    if (!statusMap) return this.handleAssessmentFailure(round, params, sessionId, extraPassCount, failureCause);
    const nowPending = this.findPendingAssessments(statusMap);
    const outcome = this.resolveRoundOutcome(
      statusMap, nowPending, round, params, sessionId, extraPassCount, pendingHistory,
    );
    if (outcome || !sessionId) return this.finalizeRound(outcome, sessionId, extraPassCount);
    return this.runFixRound(params, nowPending, round, sessionId, extraPassCount);
  }

  private async runFixRound(
    params: PlanStepVerificationRunParams, pending: StepAssessment[], round: number,
    sessionId: string, extraPassCount: number,
  ): Promise<RoundResult> {
    const fix = await params.runFixRound(this.buildFixPrompt(pending, round, params), sessionId);
    return { sessionId: fix.sessionId, extraPassCount: extraPassCount + (fix.passCount ?? 0) };
  }

  private findPendingAssessments(statusMap: Map<number, StepAssessment>): StepAssessment[] {
    return [...statusMap.values()].filter(s => s.status === 'partially-done' || s.status === 'not-done');
  }

  private logRoundStart(params: PlanStepVerificationRunParams, round: number): void {
    const roundLabel = params.refreshSteps ? `${round}/?` : `${round}/${params.stallWindow}`;
    this.logEventAndAppendToLogFile('INFO', `step-verify.round.start round=${roundLabel} stallWindow=${params.stallWindow}`, params.silent);
  }

  private buildFixPrompt(nowPending: StepAssessment[], round: number, params: PlanStepVerificationRunParams): string {
    return buildPlanStepVerificationPrompt(nowPending, round, params.refreshSteps ? undefined : params.stallWindow);
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
      `step-verify.complete rounds=${round} steps=${statusMap.size} done=${counts.done} not-applicable=${counts['not-applicable']} partially-done=${counts['partially-done']} not-done=${counts['not-done']} pending=0`,
      params.silent,
    );
    return { sessionId, summary: { rounds: round, done: counts.done + counts['not-applicable'], pending: 0 }, extraPassCount };
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
    return { sessionId, summary: { rounds: round, done: statusMap.size - pending, pending }, extraPassCount };
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
    params: PlanStepVerificationRunParams,
  ): Promise<{ steps: Map<number, StepAssessment> | undefined; failureCause?: string }> {
    let failureCause: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attemptAssessment(params, c => {
        failureCause = c;
      });
      if (result) return { steps: this.logPendingStatuses(result, params.silent) };
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
    params: PlanStepVerificationRunParams,
    onFailureCause?: (cause: string) => void,
  ): Promise<Map<number, StepAssessment> | undefined> {
    const result = await this.runSingleAssessmentAttempt(params)
      .catch(error => this.handleAssessmentAttemptError(error, onFailureCause));
    if (typeof result === 'string') {
      onFailureCause?.(`validation-error: ${result}`);
      this.logEventAndAppendToLogFile('WARN', `step-verify.assess.validation-error msg=${result}`, params.silent);
      return undefined;
    }
    return result;
  }

  private async runSingleAssessmentAttempt(
    params: PlanStepVerificationRunParams,
  ): Promise<Map<number, StepAssessment> | string> {
    const { diff, untrackedSections, truncated } = await this.captureEvidence(params);
    const steps = stripRepoNamePrefix(params.steps, params.repoDir);
    const prompt = buildStepAssessorPrompt(steps, diff, untrackedSections, truncated);
    return this.assessWithPrompt(prompt, params.steps.length);
  }

  private async assessWithPrompt(
    prompt: string, stepCount: number,
  ): Promise<Map<number, StepAssessment> | string> {
    const response = await this.aiService.execute({
      prompt,
      systemPrompt: STEP_ASSESSOR_SYSTEM_PROMPT_WITH_SCHEMA,
      temperature: 0,
      maxTokens: 4096,
      stage: 'implement',
      structuredOutput: { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema },
    });
    const validated = stepAssessmentResponseSchema.parse(parseJsonResponse<unknown>(response.content));
    const result = validateStepAssessments(validated.statuses, stepCount);
    return this.logInvalidAssessmentBody(result, response.content);
  }

  private logInvalidAssessmentBody(
    result: Map<number, StepAssessment> | string, responseBody: string,
  ): Map<number, StepAssessment> | string {
    if (typeof result === 'string') {
      appendToLogFile('DEBUG', `step-verify.assess.raw-response body=${responseBody}`, 'step-verification');
    }
    return result;
  }

  private logAssessmentSummary(
    statusMap: Map<number, StepAssessment>,
    counts: Record<string, number>,
    silent?: boolean,
  ): void {
    this.logEventAndAppendToLogFile(
      'INFO',
      `step-verify.assessed steps=${statusMap.size} done=${counts.done} not-applicable=${counts['not-applicable']} partially-done=${counts['partially-done']} not-done=${counts['not-done']}`,
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
    params: PlanStepVerificationRunParams,
  ): Promise<{ diff: string; untrackedSections: string[]; truncated: boolean }> {
    const rawDiff = await this.getDiff(params.repoDir, params.baseRef ?? 'HEAD');
    const untrackedSections = await this.collectUntrackedSections(params.repoDir);
    const combined = rawDiff + untrackedSections.join('\n\n');
    if (combined.length <= MAX_ASSESSOR_EVIDENCE_CHARS) {
      return { diff: rawDiff, untrackedSections, truncated: false };
    }
    this.logEventAndAppendToLogFile('WARN', `step-verify.diff.truncated original=${combined.length}`, params.silent);
    return { diff: combined.slice(0, MAX_ASSESSOR_EVIDENCE_CHARS), untrackedSections: [], truncated: true };
  }

  private async getDiff(repoDir: string, baseRef: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['diff', baseRef], {
        cwd: repoDir,
        maxBuffer: MAX_ASSESSOR_EVIDENCE_CHARS * 2,
      });
      return stdout;
    } catch {
      return '';
    }
  }

  private async collectUntrackedSections(repoDir: string): Promise<string[]> {
    const status = await this.gitService.getStatus(repoDir);
    const untrackedFiles: string[] = (status as { not_added?: string[] }).not_added ?? [];
    const sections: string[] = [];
    for (const file of untrackedFiles) {
      try {
        sections.push(`### ${file}\n\`\`\`\n${fs.readFileSync(path.resolve(repoDir, file), 'utf-8')}\n\`\`\``);
      } catch {
        appendToLogFile('DEBUG', `step-verify.untracked.unreadable path=${file}`, 'step-verification');
      }
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
