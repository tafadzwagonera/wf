import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVIDENCE_CEILING_CHARS,
  EVIDENCE_FLOOR_CHARS,
  allocateEvidence,
  buildEvidenceCompletenessSection,
  computeEvidenceBudget,
  type EvidenceSection,
} from '../../agents/plan-step-evidence-budget';
import { AiService, parseJsonResponse } from '../../integrations/ai/ai.service';
import { appendToLogFile } from '../../shared/logger/log-file-writer';
import {
  commitDescriptionResponseJsonSchema,
  commitDescriptionResponseSchema,
} from '../../shared/schemas/commit-description.schema';
import type { ResolutionAction, StageProgressCallback } from '../../shared/types/agent.types';
import type { AIStageName } from '../../shared/types/ai.types';
import type { CommitDescriptionResponse } from '../../shared/types/commit-description.types';
import { hashCommitDescriptionDiff } from '../../shared/utils/commit-description-artifact';
import {
  formatDiffStatSummary,
  parseDiffFileStats,
  splitDiffIntoFileSections,
} from '../../shared/utils/commit-diff-stat';

const LOG_CONTEXT = 'commit-description';

const COMMIT_DESCRIPTION_SYSTEM_PROMPT = [
  'You describe a code change for use as commit-message context.',
  'Base the description only on the diff evidence provided; do not speculate about intent beyond it.',
  'When a "Declared action" section is present, treat it as the developer-declared intent that scopes',
  'what the description emphasizes and how the nature is classified; the diff remains authoritative.',
  'Return JSON matching the enforced schema: "nature" classifies the change as feature, fix, refactor, docs, test, chore, or mixed;',
  '"description" is one to three plain sentences stating what the change does and why it matters.',
  'Mention every distinct concern in the diff. Output nothing else.',
].join(' ');

interface GenerateParams {
  diff: string;
  stage: AIStageName;
  action?: ResolutionAction;
  onProgress?: StageProgressCallback;
}

interface GenerateAndPersistParams extends GenerateParams {
  artifactPath: string;
}

const buildEvidenceSections = (diff: string): EvidenceSection[] => {
  const sections = splitDiffIntoFileSections(diff);
  return parseDiffFileStats(diff)
    .sort((a, b) => b.changedLines - a.changedLines)
    .map(({ file }): EvidenceSection => ({
      path: file,
      kind: 'tracked',
      content: sections.get(file) ?? '',
      mentioned: false,
    }));
};

const computeBudget = (sections: EvidenceSection[], statSummary: string): number =>
  computeEvidenceBudget({
    measuredTotal: sections.reduce((sum, s) => sum + s.content.length, 0),
    nameStatusLength: statSummary.length,
    floor: EVIDENCE_FLOOR_CHARS,
    ceiling: EVIDENCE_CEILING_CHARS,
  });

interface PromptInputs {
  statSummary: string;
  fileDiffs: string[];
  completeness: string;
  action?: ResolutionAction;
}

const renderActionScope = (action: ResolutionAction): string[] => [
  '## Declared action',
  `The developer ran this workflow with action "${action}". Scope the description to that intent: emphasize what `
  + 'serves it and prefer the matching nature classification, unless the diff evidence contradicts it.',
  '',
];

const renderPrompt = ({ statSummary, fileDiffs, completeness, action }: PromptInputs): string =>
  [
    'Describe the following change.', '',
    ...(action ? renderActionScope(action) : []),
    '## Changed files (complete list)', statSummary, '',
    '## Per-file diffs', fileDiffs.join('\n\n'),
    completeness, '',
  ].join('\n');

const buildDescriptionPrompt = (diff: string, action?: ResolutionAction): string => {
  const sections = buildEvidenceSections(diff);
  const statSummary = formatDiffStatSummary(parseDiffFileStats(diff));
  const { rendered, report } = allocateEvidence(sections, computeBudget(sections, statSummary));
  const fileDiffs = sections.filter(s => rendered.has(s.path)).map(s => rendered.get(s.path) ?? '');
  return renderPrompt({ statSummary, fileDiffs, completeness: buildEvidenceCompletenessSection(report), action });
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

@Injectable()
export class CommitDescriptionStageService {
  constructor(private readonly aiService: AiService) {}

  async generate({ diff, stage, action, onProgress }: GenerateParams): Promise<CommitDescriptionResponse | null> {
    if (!diff.trim()) {
      appendToLogFile('DEBUG', 'commit-description.skip reason=empty-diff', LOG_CONTEXT);
      return null;
    }
    try {
      onProgress?.('Generating commit description...');
      return await this.requestDescription(diff, stage, action);
    } catch (error) {
      appendToLogFile('WARN', `commit-description.generate.failed reason=${describeError(error)}`, LOG_CONTEXT);
      return null;
    }
  }

  private async requestDescription(
    diff: string, stage: AIStageName, action?: ResolutionAction
  ): Promise<CommitDescriptionResponse> {
    const response = await this.aiService.execute({
      prompt: buildDescriptionPrompt(diff, action),
      systemPrompt: COMMIT_DESCRIPTION_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 512,
      stage,
      structuredOutput: { name: 'commit_description', schema: commitDescriptionResponseJsonSchema },
    });
    return commitDescriptionResponseSchema.parse(parseJsonResponse<unknown>(response.content));
  }

  async generateAndPersist({ diff, stage, action, artifactPath, onProgress }: GenerateAndPersistParams): Promise<void> {
    const description = await this.generate({ diff, stage, action, onProgress });
    if (!description) return;
    const record = { ...description, diffSha256: hashCommitDescriptionDiff(diff) };
    try {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, JSON.stringify(record, null, 2));
      appendToLogFile('DEBUG', `commit-description.persisted path=${artifactPath}`, LOG_CONTEXT);
    } catch (error) {
      const reason = describeError(error);
      appendToLogFile('WARN', `commit-description.persist.failed path=${artifactPath} reason=${reason}`, LOG_CONTEXT);
    }
  }
}
