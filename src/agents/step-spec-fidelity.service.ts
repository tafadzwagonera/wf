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
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';

export type AssessableStep = { index: number; text: string };

const MAX_FIDELITY_DIFF_CHARS = 60_000;

export interface StepSpecFidelityRunParams {
  stepText: string;
  diff: string;
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

export const buildSpecFidelityPrompt = (stepText: string, diff: string): string =>
  `## Plan step\n\n${stepText}\n\n## Changed files diff\n\n${diff}\n\n## Your task\n\n${fidelityTaskInstructions}`;

@Injectable()
export class StepSpecFidelityService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
  ) {}

  async verifyAll(steps: AssessableStep[], repoDir: string, baseRef?: string): Promise<StepFidelityVerificationResult> {
    const result = this.createVerificationResult(steps);
    const [diff] = await executeAsyncWithCatch({
      fn: () => this.captureDiff(repoDir, baseRef ?? 'HEAD'),
      onError: err => this.addDiffFailure(result, err),
    });
    if (diff === undefined) return result;
    await this.processSteps(steps, diff, result);
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
  ): Promise<void> {
    for (const step of steps) {
      const r = await this.run({ stepText: step.text, diff });
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
        maxTokens: 2048,
        stage: 'implement',
        structuredOutput: { name: 'step_spec_fidelity', schema: stepFidelityResponseJsonSchema },
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
    const diff = await this.gitService.getDiffFromRef(baseRef, repoDir);
    return diff.slice(0, MAX_FIDELITY_DIFF_CHARS);
  }
}
