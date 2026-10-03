import { Injectable } from '@nestjs/common';
import { parseJsonResponse } from '../integrations/ai/ai.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { stepAssessmentResponseJsonSchema, stepAssessmentResponseSchema } from '../shared/schemas/step-verification.schema';
import type { WfAiProviderName, WfBackendMode } from '../shared/types/config.types';
import type { StepAssessment } from '../shared/types/step-verification.types';
import { ConfigurationError } from '../shared/utils/errors';
import type { AssessableStep } from './step-spec-fidelity.service';

export type PullStepAssessmentParams = {
  steps: AssessableStep[];
  repoDir: string;
  baseRef: string;
  provider?: WfAiProviderName;
  model?: string;
  backend?: WfBackendMode;
};

const PULL_STEP_ASSESSOR_SYSTEM_PROMPT
  = 'You are a meticulous implementation auditor with read-only access to the repository. Inspect the repository before judging any step. Output ONLY valid JSON.';

const PULL_STATUS_RULES = [
  '## Status rules',
  '- done: fully implemented in the repository state you inspected',
  '- partially-done: started but incomplete (requires missing field)',
  '- not-done: not implemented, including any named file you could not find after searching (requires missing field)',
  '- not-applicable: step requires no code change or cannot be proven from repository state (e.g. run-the-tests steps, confirm-existing-behavior steps)',
  '- unverifiable: ONLY for temporal, process, or investigation claims that repository state cannot in principle prove or disprove (requires missing field)',
  '- Paths under another repository prefix are outside this assessment; judge only the current repository portion.',
];

const PULL_EVIDENCE_INSTRUCTIONS = (baseRef: string): string[] => [
  '## How to gather evidence',
  `- First run \`git diff ${baseRef} --stat\` to enumerate every changed file.`,
  `- For each step, inspect relevant changes with \`git diff ${baseRef} -- <path>\` and read the files themselves.`,
  '- Run `git status` to discover untracked new files and read any that a step names.',
  '- Inspect before judging. Do not assume changes you have not seen.',
];

const PULL_RESPONSE_INSTRUCTIONS = [
  'Index each step ONLY by its [Plan step N] tag.',
  'Produce exactly one entry per [Plan step N] tag above — no more, no fewer — in this shape:',
  '{"statuses":[{"index":0,"status":"done"},{"index":1,"status":"partially-done","missing":"…"}]}',
];

export const buildPullStepAssessorPrompt = (steps: AssessableStep[], baseRef: string): string => {
  const numbered = steps.map(step => `[Plan step ${step.index}]\n${step.text}`).join('\n\n');
  return [
    '## Steps to assess',
    numbered,
    '',
    ...PULL_EVIDENCE_INSTRUCTIONS(baseRef),
    '',
    ...PULL_STATUS_RULES,
    '',
    ...PULL_RESPONSE_INSTRUCTIONS,
  ].join('\n');
};

const resolvePullProvider = (provider?: WfAiProviderName): 'anthropic' | 'openai' | undefined => {
  if (!provider || provider === 'anthropic' || provider === 'openai') return provider;
  throw new ConfigurationError(`Pull step verification is unsupported for provider "${provider}".`);
};

@Injectable()
export class PullStepAssessorService {
  constructor(private readonly stageAgentService: StageAgentService) {}

  async assess(params: PullStepAssessmentParams): Promise<StepAssessment[]> {
    const result = await this.stageAgentService.chatTurn({
      stage: 'implement',
      systemPrompt: PULL_STEP_ASSESSOR_SYSTEM_PROMPT,
      userMessage: buildPullStepAssessorPrompt(params.steps, params.baseRef),
      repoDir: params.repoDir,
      providerOverride: resolvePullProvider(params.provider),
      modelOverride: params.model,
      ...(params.backend && { backendOverride: params.backend }),
      structuredOutput: { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema },
      responseValidator: { label: 'plan_step_assessment', parse: value => stepAssessmentResponseSchema.parse(value) },
    });
    return parseJsonResponse<{ statuses: StepAssessment[] }>(result.content).statuses;
  }
}
