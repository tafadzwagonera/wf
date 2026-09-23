import { Injectable } from '@nestjs/common';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { stepFidelityResponseSchema } from '../shared/schemas/step-spec-fidelity.schema';
import type { StepFidelityFinding } from '../shared/types/step-spec-fidelity.types';

const MAX_FIDELITY_DIFF_CHARS = 60_000;

export interface StepSpecFidelityRunParams {
  stepText: string;
  diff: string;
}

const FIDELITY_TASK_INSTRUCTIONS = [
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
  `## Plan step\n\n${stepText}\n\n## Changed files diff\n\n${diff}\n\n## Your task\n\n${FIDELITY_TASK_INSTRUCTIONS}`;

@Injectable()
export class StepSpecFidelityService {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
  ) {}

  async verifyAll(steps: string[], repoDir: string, baseRef?: string): Promise<StepFidelityFinding[][]> {
    const diff = await this.captureDiff(repoDir, baseRef ?? 'HEAD');
    const results: StepFidelityFinding[][] = [];
    for (const stepText of steps) {
      results.push(await this.run({ stepText, diff }));
    }
    return results;
  }

  async run(params: StepSpecFidelityRunParams): Promise<StepFidelityFinding[]> {
    if (!params.diff.trim()) return [];
    try {
      const prompt = buildSpecFidelityPrompt(params.stepText, params.diff);
      const response = await this.aiService.execute({ prompt, maxTokens: 2048, stage: 'review' });
      const parsed = stepFidelityResponseSchema.parse(parseJsonResponse(response.content));
      return parsed.findings;
    } catch {
      return [];
    }
  }

  private async captureDiff(repoDir: string, baseRef: string): Promise<string> {
    try {
      const diff = await this.gitService.getDiffFromRef(baseRef, repoDir);
      return diff.slice(0, MAX_FIDELITY_DIFF_CHARS);
    } catch {
      return '';
    }
  }
}
