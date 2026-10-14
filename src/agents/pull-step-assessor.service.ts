import { Injectable } from '@nestjs/common';
import { parseJsonResponse } from '../integrations/ai/ai.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import {
  pullStepAssessmentResponseJsonSchema,
  pullStepAssessmentResponseSchema,
} from '../shared/schemas/step-verification.schema';
import type { WfAiProviderName, WfBackendMode } from '../shared/types/config.types';
import type { PullStepAssessmentResponse } from '../shared/types/step-verification.types';
import { ConfigurationError } from '../shared/utils/errors';
import { buildStepResponseShapeLines, unverifiableRule } from './plan-step-evidence-budget';
import type { AssessableStep } from './step-spec-fidelity.service';

export type PullStepAssessmentParams = {
  steps: AssessableStep[];
  repoDir: string;
  baseRef: string;
  changedPaths: string[];
  untrackedPaths: string[];
  executionEvidenceSection?: string;
  provider?: WfAiProviderName;
  model?: string;
  backend?: WfBackendMode;
};

const PULL_STEP_ASSESSOR_SYSTEM_PROMPT
  = 'You are a meticulous implementation auditor with read-only access to the repository. Inspect the repository before judging any step. Output ONLY valid JSON.';

const pullStatusRules = [
  '## Status rules',
  '- done: fully implemented in the repository state you inspected',
  '- partially-done: started but incomplete (requires missing field)',
  '- not-done: not implemented, including any named file you could not find after searching (requires missing field)',
  '- not-applicable: step requires no code change or cannot be proven from repository state (e.g. run-the-tests steps, confirm-existing-behavior steps)',
  unverifiableRule('repository state'),
  '- Paths under another repository prefix are outside this assessment; judge only the current repository portion.',
];

const pullEvidenceInstructions = (baseRef: string): string[] => [
  '## How to gather evidence',
  `- First run \`git diff ${baseRef} --stat\` to enumerate every changed file.`,
  `- For each step, inspect relevant changes with \`git diff ${baseRef} -- <path>\` and read the files themselves.`,
  '- Run `git status` to discover untracked new files and read any that a step names.',
  '- Inspect before judging. Do not assume changes you have not seen.',
];

const buildPullResponseInstructions = (indices: number[]): string[] => [
  'Index each step ONLY by its [Plan step N] tag.',
  ...buildStepResponseShapeLines(indices, { includeInspectedPaths: true }),
];

const buildInspectionChecklistSection = (
  args: { baseRef: string; changedPaths: string[]; untrackedPaths: string[] },
): string[] => [
  '## Mandatory inspection checklist',
  ...args.changedPaths.map(path => `- changed: \`git diff ${args.baseRef} -- ${path}\``),
  ...args.untrackedPaths.map(path => `- untracked: read the file ${path}`),
  'Read every hunk of every listed file. Do not judge any step before covering the whole list.',
];

type PullPromptArgs = Pick<PullStepAssessmentParams, 'steps' | 'baseRef' | 'changedPaths' | 'untrackedPaths'>
  & { executionEvidenceSection?: string };

const renderNumberedSteps = (steps: AssessableStep[]): string =>
  steps.map(step => `[Plan step ${step.index}]\n${step.text}`).join('\n\n');

export const buildPullStepAssessorPrompt = (args: PullPromptArgs): string => [
  '## Steps to assess',
  renderNumberedSteps(args.steps),
  '',
  ...pullEvidenceInstructions(args.baseRef),
  '',
  ...buildInspectionChecklistSection(args),
  '',
  ...(args.executionEvidenceSection ? [args.executionEvidenceSection, ''] : []),
  ...pullStatusRules,
  '',
  ...buildPullResponseInstructions(args.steps.map(step => step.index)),
].join('\n');

const resolvePullProvider = (provider?: WfAiProviderName): 'anthropic' | 'openai' | undefined => {
  if (!provider || provider === 'anthropic' || provider === 'openai') return provider;
  throw new ConfigurationError(`Pull step verification is unsupported for provider "${provider}".`);
};

@Injectable()
export class PullStepAssessorService {
  constructor(private readonly stageAgentService: StageAgentService) {}

  async assess(params: PullStepAssessmentParams): Promise<PullStepAssessmentResponse> {
    const result = await this.stageAgentService.chatTurn({
      stage: 'implement',
      systemPrompt: PULL_STEP_ASSESSOR_SYSTEM_PROMPT,
      userMessage: buildPullStepAssessorPrompt(params),
      repoDir: params.repoDir,
      providerOverride: resolvePullProvider(params.provider),
      modelOverride: params.model,
      ...(params.backend && { backendOverride: params.backend }),
      structuredOutput: { name: 'plan_step_assessment', schema: pullStepAssessmentResponseJsonSchema },
      responseValidator: { label: 'plan_step_assessment', parse: value => pullStepAssessmentResponseSchema.parse(value) },
    });
    const { statuses, inspectedPaths } = parseJsonResponse<PullStepAssessmentResponse>(result.content);
    return { statuses, inspectedPaths };
  }
}
