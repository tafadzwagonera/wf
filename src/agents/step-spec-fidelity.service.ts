import { Injectable } from '@nestjs/common';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import {
  stepFidelityResponseSchema,
  stepFidelityResponseJsonSchema,
} from '../shared/schemas/step-spec-fidelity.schema';
import type {
  StepFidelityFinding,
  StepFidelityFailure,
  StepFidelityVerificationResult,
} from '../shared/types/step-spec-fidelity.types';
import type { WfAiProviderName, WfBackendMode } from '../shared/types/config.types';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { appendToLogFile } from '../shared/logger/log-file-writer';
import { splitDiffIntoFileSections } from '../shared/utils/commit-diff-stat';
import {
  EVIDENCE_FLOOR_CHARS, allocateEvidence, sliceHeadTail, type EvidenceSection,
} from './plan-step-evidence-budget';

export type AssessableStep = { index: number; text: string };

const FIDELITY_CEILING_CHARS = 120_000;

const clampFidelityBudget = (measuredTotal: number): number =>
  Math.min(FIDELITY_CEILING_CHARS, Math.max(EVIDENCE_FLOOR_CHARS, measuredTotal));

const stripSectionHeading = (rendered: string, filePath: string): string =>
  rendered.slice(`### ${filePath}\n`.length);

export interface StepSpecFidelityRunParams {
  stepText: string;
  diff: string;
  provider?: WfAiProviderName;
  model?: string;
  backend?: WfBackendMode;
}

type RunResult = { findings: StepFidelityFinding[]; failure?: StepFidelityFailure };

const fidelityTaskInstructions = [
  'Extract every LITERAL, CONCRETE claim the plan step makes — claims that can be proven or',
  'disproven by reading the diff alone:',
  String.raw`  - Regular expression patterns (e.g. /\.(vue|tsx|jsx)$/)`,
  '  - Required function parameters, return conditions, or return values',
  '    (e.g. "returns null when totalSamples < 3")',
  '  - Required test assertion targets (e.g. "must assert `occurrences` and `totalSamples`")',
  '  - Exact threshold values, constant names, or string literals',
  '',
  'For each literal claim, check whether the diff satisfies it exactly.',
  '',
  'Classify each deviation as:',
  '  - "error"   — the step specifies X and the diff shows Y (concrete mismatch)',
  '  - "warning" — the step specifies X and the diff is silent (cannot confirm from diff alone)',
  '',
  'Do NOT flag:',
  '  - Anything the step does not explicitly specify',
  '  - Style, naming conventions, or subjective quality',
  '  - Steps whose content is "run tests" or "commit" — those are not verifiable from a diff',
  '',
  'Return ONLY valid JSON:',
  '{"findings":[{"severity":"error","claim":"<exact literal>","deviation":"<what diff shows or lacks>"}]}',
  '',
  'Return {"findings":[]} when there are no deviations.',
].join('\n');

const EVIDENCE_GAP_NOTE = [
  'Note: the diff contains "[... evidence gap: N chars omitted ...]" markers or omitted files.',
  'Content beyond a gap is unknown, not absent — do not flag claims solely because they sit in a gap.',
  '',
  '',
].join('\n');

export const buildSpecFidelityPrompt = (stepText: string, diff: string): string => {
  const gapNote = diff.includes('[... evidence gap:') ? EVIDENCE_GAP_NOTE : '';
  return `## Plan step\n\n${stepText}\n\n## Changed files diff\n\n${gapNote}${diff}\n\n## Your task\n\n${fidelityTaskInstructions}`;
};

@Injectable()
export class StepSpecFidelityService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
  ) {}

  async verifyAll(
    steps: AssessableStep[],
    repoDir: string,
    baseRef?: string,
    assessorTarget?: { assessorProvider?: WfAiProviderName; assessorModel?: string; assessorBackend?: WfBackendMode },
  ): Promise<StepFidelityVerificationResult> {
    const result = this.createVerificationResult(steps);
    const [diff] = await executeAsyncWithCatch({
      fn: () => this.captureDiff(repoDir, baseRef ?? 'HEAD'),
      onError: err => this.addDiffFailure(result, err),
    });
    if (diff === undefined) return result;
    await this.processSteps(steps, diff, result, assessorTarget);
    return result;
  }

  private addDiffFailure(result: StepFidelityVerificationResult, error: unknown): void {
    result.failures.push({ category: 'diff', cause: this.extractCause(error) });
  }

  private createVerificationResult(steps: AssessableStep[]): StepFidelityVerificationResult {
    return { findingsPerStep: new Map(steps.map(step => [step.index, []])), failures: [] };
  }

  private async processSteps(
    steps: AssessableStep[], diff: string, result: StepFidelityVerificationResult,
    assessorTarget?: { assessorProvider?: WfAiProviderName; assessorModel?: string; assessorBackend?: WfBackendMode },
  ): Promise<void> {
    const { assessorProvider: provider, assessorModel: model, assessorBackend: backend } = assessorTarget ?? {};
    const loggedGaps = new Set<string>();
    for (const step of steps) {
      const stepDiff = this.fitDiffToBudget(diff, step.text, loggedGaps);
      const r = await this.run({ stepText: step.text, diff: stepDiff, provider, model, backend });
      result.findingsPerStep.set(step.index, r.findings);
      if (r.failure) {
        result.failures.push({ ...r.failure, stepIndex: step.index });
      }
    }
  }

  async run(params: StepSpecFidelityRunParams): Promise<RunResult> {
    if (!params.diff.trim()) return { findings: [] };
    try {
      const res = await this.aiService.execute({
        prompt: buildSpecFidelityPrompt(params.stepText, params.diff),
        maxTokens: 2048, stage: 'implement',
        structuredOutput: { name: 'step_spec_fidelity', schema: stepFidelityResponseJsonSchema },
        ...(params.provider && { provider: params.provider }), ...(params.model && { model: params.model }),
        ...(params.backend && { backend: params.backend }),
      });
      return this.parseAndReturn(res.content);
    } catch (e) {
      return { findings: [], failure: { category: 'provider', cause: this.extractCause(e) } };
    }
  }

  private parseAndReturn(content: string): RunResult {
    try {
      return { findings: stepFidelityResponseSchema.parse(parseJsonResponse(content)).findings };
    } catch (e) {
      return { findings: [], failure: { category: 'response', cause: this.extractCause(e) } };
    }
  }

  private extractCause(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private async captureDiff(repoDir: string, baseRef: string): Promise<string> {
    return this.gitService.getDiffFromRef(baseRef, repoDir);
  }

  private fitDiffToBudget(diff: string, stepText: string, loggedGaps: Set<string>): string {
    const fileSections = splitDiffIntoFileSections(diff);
    if (fileSections.size === 0) return this.fitUnsectionedDiff(diff, loggedGaps);
    const sections: EvidenceSection[] = [...fileSections].map(([filePath, content]) => ({
      path: filePath, kind: 'tracked', content, mentioned: stepText.includes(filePath),
    }));
    const measuredTotal = sections.reduce((sum, section) => sum + section.content.length, 0);
    const { rendered, report } = allocateEvidence(sections, clampFidelityBudget(measuredTotal));
    const gapPaths = [...report.truncated.map(t => t.path), ...report.omitted];
    return gapPaths.length ? this.rejoinTruncated(sections, rendered, gapPaths, loggedGaps) : diff;
  }

  private rejoinTruncated(
    sections: EvidenceSection[], rendered: Map<string, string>, gapPaths: string[], loggedGaps: Set<string>,
  ): string {
    this.logGapOnce(`paths=${gapPaths.join(',')}`, loggedGaps);
    return sections
      .filter(section => rendered.has(section.path))
      .map(section => stripSectionHeading(rendered.get(section.path) ?? '', section.path))
      .join('\n');
  }

  private fitUnsectionedDiff(diff: string, loggedGaps: Set<string>): string {
    const fitted = sliceHeadTail(diff, clampFidelityBudget(diff.length));
    if (fitted.length < diff.length) this.logGapOnce('paths=(unsectioned diff)', loggedGaps);
    return fitted;
  }

  private logGapOnce(detail: string, loggedGaps: Set<string>): void {
    if (loggedGaps.has(detail)) return;
    loggedGaps.add(detail);
    appendToLogFile('WARN', `step-fidelity.diff.truncated ${detail}`, 'step-verification');
  }
}
