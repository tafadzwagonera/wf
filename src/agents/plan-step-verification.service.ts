import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { appendToLogFile } from '../shared/logger/log-file-writer';
import { stepAssessmentResponseSchema } from '../shared/schemas/step-verification.schema';
import type { StepAssessment, StepVerificationSummary } from '../shared/types/step-verification.types';

const execFileAsync = promisify(execFile);
const MAX_ASSESSOR_EVIDENCE_CHARS = 60_000;

const STEP_ASSESSOR_SYSTEM_PROMPT
  = 'You are a meticulous implementation auditor. Judge only from the evidence provided. Output ONLY valid JSON.';

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
  refreshSteps?: () => Promise<string[] | null>;
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
  const roundHeader = stallWindow !== undefined
    ? `Verification round ${round} (stall window: ${stallWindow}): a post-implementation audit found plan steps that are not fully implemented.`
    : `Verification round ${round}: a post-implementation audit found plan steps that are not fully implemented.`;
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
    private readonly configService: ConfigService,
    private readonly aiService: AiService,
    private readonly gitService: GitService,
    private readonly presenter: CliPresenter,
  ) {}

  async run(params: PlanStepVerificationRunParams): Promise<PlanStepVerificationOutcome> {
    try {
      const target = this.resolveAssessorTarget();
      if (!target) {
        this.logEventAndAppendToLogFile('WARN', 'step-verify.target.unresolved', params.silent);
        return { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
      }
      return await this.runVerificationLoop(params, target);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logEventAndAppendToLogFile('ERROR', `step-verify.error cause=${cause}`, params.silent);
      return { sessionId: params.sessionId, summary: undefined, extraPassCount: 0 };
    }
  }

  private async runVerificationLoop(
    params: PlanStepVerificationRunParams,
    target: { provider: string; model: string },
  ): Promise<PlanStepVerificationOutcome> {
    let sessionId: string | undefined = params.sessionId;
    let extraPassCount = 0, consecutiveFailures = 0;
    for (let round = 1; ; round += 1) {
      const result = await this.runOneRound(params, target, round, sessionId, extraPassCount, params.steps.length);
      if (result.outcome) return result.outcome;
      consecutiveFailures = result.assessmentFailed ? consecutiveFailures + 1 : 0;
      const stalled = this.checkConsecutiveFailureLimit(consecutiveFailures, params, sessionId, extraPassCount);
      if (stalled) return stalled;
      ({ sessionId, extraPassCount } = result);
    }
  }

  private checkConsecutiveFailureLimit(
    count: number, params: PlanStepVerificationRunParams,
    sessionId: string | undefined, extraPassCount: number,
  ): PlanStepVerificationOutcome | null {
    if (!params.refreshSteps || count < params.stallWindow) return null;
    this.logEventAndAppendToLogFile('WARN', `step-verify.exhausted reason=assessor-returned-invalid-json-${count}-rounds-in-a-row stallWindow=${params.stallWindow}`, params.silent);
    return { sessionId, summary: undefined, extraPassCount };
  }

  private async runOneRound(
    params: PlanStepVerificationRunParams, target: { provider: string; model: string },
    round: number, sessionId: string | undefined, extraPassCount: number, n: number,
  ): Promise<RoundResult> {
    if (!params.refreshSteps) {
      return this.executeRound(params, target, round, sessionId, extraPassCount, n, params.steps);
    }
    const fresh = await params.refreshSteps();
    if (fresh === null) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.fidelity.stalled round=${round}`, params.silent);
      return { outcome: { sessionId, summary: undefined, extraPassCount }, extraPassCount };
    }
    return this.executeRound(params, target, round, sessionId, extraPassCount, n, fresh);
  }

  private async executeRound(
    params: PlanStepVerificationRunParams, target: { provider: string; model: string },
    round: number, sessionId: string | undefined, extraPassCount: number, n: number, activeSteps: string[],
  ): Promise<RoundResult> {
    const roundLabel = params.refreshSteps ? `${round}/?` : `${round}/${params.stallWindow}`;
    this.logEventAndAppendToLogFile('INFO', `step-verify.round.start round=${roundLabel} stallWindow=${params.stallWindow}`, params.silent);
    const statusMap = await this.assessSteps({ ...params, steps: activeSteps }, target);
    if (!statusMap) return this.handleAssessmentFailure(round, params, sessionId, extraPassCount);
    const nowPending = [...statusMap.values()].filter(s => s.status === 'partially-done' || s.status === 'not-done');
    const outcome = this.resolveRoundOutcome(nowPending, round, params, sessionId, n, extraPassCount);
    if (outcome || !sessionId) return this.finalizeRound(outcome, sessionId, extraPassCount);
    const fix = await params.runFixRound(this.buildFixPrompt(nowPending, round, params), sessionId);
    return { sessionId: fix.sessionId, extraPassCount: extraPassCount + (fix.passCount ?? 0) };
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
  ): RoundResult {
    if (params.refreshSteps || round < params.stallWindow) return { sessionId, extraPassCount, assessmentFailed: true };
    this.logEventAndAppendToLogFile('WARN', `step-verify.exhausted reason=assessor-returned-invalid-json-on-final-round round=${round} stallWindow=${params.stallWindow}`, params.silent);
    return { outcome: { sessionId, summary: undefined, extraPassCount }, extraPassCount };
  }

  private resolveRoundOutcome(
    nowPending: StepAssessment[], round: number, params: PlanStepVerificationRunParams,
    sessionId: string | undefined, n: number, extraPassCount: number,
  ): PlanStepVerificationOutcome | null {
    if (nowPending.length === 0) {
      this.logEventAndAppendToLogFile('INFO', `step-verify.complete rounds=${round} steps=${n} done=${n} pending=0`, params.silent);
      return { sessionId, summary: { rounds: round, done: n, pending: 0 }, extraPassCount };
    }
    if (sessionId && (params.refreshSteps || round !== params.stallWindow)) return null;
    const reason = sessionId ? `step-verify.exhausted pending=${nowPending.length}` : 'step-verify.session.missing';
    this.logEventAndAppendToLogFile('WARN', reason, params.silent);
    this.logMissedSteps(nowPending, params.silent);
    const pending = nowPending.length;
    return { sessionId, summary: { rounds: round, done: n - pending, pending }, extraPassCount };
  }

  private logMissedSteps(nowPending: StepAssessment[], silent?: boolean): void {
    for (const p of nowPending) {
      this.logEventAndAppendToLogFile('WARN', `step-verify.missed index=${p.index} status=${p.status} missing=${p.missing ?? 'n/a'}`, silent);
    }
  }

  private async assessSteps(
    params: PlanStepVerificationRunParams,
    target: { provider: string; model: string },
  ): Promise<Map<number, StepAssessment> | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attemptAssessment(params, target);
      if (result) return this.logPendingStatuses(result, params.silent);
    }
    this.logEventAndAppendToLogFile('ERROR', 'step-verify.assess.invalid', params.silent);
    return undefined;
  }

  private async attemptAssessment(
    params: PlanStepVerificationRunParams,
    target: { provider: string; model: string },
  ): Promise<Map<number, StepAssessment> | undefined> {
    const result = await this.runSingleAssessmentAttempt(params, target).catch(error => {
      const cause = error instanceof Error ? error.message : String(error);
      appendToLogFile('ERROR', `step-verify.assess.attempt-failed cause=${cause}`, 'step-verification');
      return undefined;
    });
    if (typeof result === 'string') {
      this.logEventAndAppendToLogFile('WARN', `step-verify.assess.validation-error msg=${result}`, params.silent);
      return undefined;
    }
    return result;
  }

  private async runSingleAssessmentAttempt(
    params: PlanStepVerificationRunParams,
    target: { provider: string; model: string },
  ): Promise<Map<number, StepAssessment> | string> {
    const { diff, untrackedSections, truncated } = await this.captureEvidence(params);
    const prompt = buildStepAssessorPrompt(params.steps, diff, untrackedSections, truncated);
    const response = await this.aiService.execute({
      prompt, systemPrompt: STEP_ASSESSOR_SYSTEM_PROMPT,
      temperature: 0, maxTokens: 4096,
      provider: target.provider, model: target.model,
    });
    const validated = stepAssessmentResponseSchema.parse(parseJsonResponse<unknown>(response.content));
    const result = validateStepAssessments(validated.statuses, params.steps.length);
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
    const counts = { done: 0, 'not-applicable': 0, 'partially-done': 0, 'not-done': 0 };
    for (const [, s] of statusMap) {
      counts[s.status]++;
      if (s.status !== 'done' && s.status !== 'not-applicable') {
        this.logEventAndAppendToLogFile('INFO', `step-verify.status index=${s.index} status=${s.status}`, silent);
      }
    }
    this.logAssessmentSummary(statusMap, counts, silent);
    return statusMap;
  }

  private resolveAssessorTarget(): { provider: string; model: string } | undefined {
    const implProvider = this.configService.get<string>('stages.implement.provider');
    if (!implProvider) return this.resolveFallbackTarget();
    const implModel
      = this.configService.get<string>('stages.implement.model')
        ?? this.configService.get<string>('stages.implement.models.default')
        ?? this.configService
          .get<Array<{ provider: string; model: string }>>('ai.providers')
          ?.find(p => p.provider === implProvider)?.model;
    if (!implModel) return undefined;
    return { provider: implProvider, model: implModel };
  }

  private resolveFallbackTarget(): { provider: string; model: string } | undefined {
    const provider = this.configService.get<string>('ai.provider');
    const model = this.configService.get<string>('ai.model');
    if (!provider || !model) return undefined;
    return { provider, model };
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

  private logEventAndAppendToLogFile(level: string, message: string, silent?: boolean): void {
    appendToLogFile(level, message, 'step-verification');
    if (!silent) this.presenter.progress(`  [step-verify] ${message}`);
  }
}
