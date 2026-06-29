import { Injectable } from '@nestjs/common';
import { AiService } from '../../integrations/ai/ai.service';

@Injectable()
export class SummaryService {
  constructor(private readonly aiService: AiService) {}

  async generateStageSummary(params: { stage: string; stageOutput: string; ticketKey: string }): Promise<string> {
    const prompt = `Summarize the following ${params.stage} output for handoff to the next workflow stage. Focus on: key decisions made, files affected, risks identified, and important context the next stage needs. Output structured markdown with sections: ## Decisions, ## Key Changes, ## Context for Next Stage, ## Risks. Be concise (under 500 words).

Ticket: ${params.ticketKey}
Stage: ${params.stage}

Output:
${params.stageOutput}`;

    const result = await this.aiService.execute({
      prompt,
      maxTokens: 1024,
      systemPrompt:
        'You are a technical summarizer. Produce concise, structured markdown summaries for workflow handoff.',
    });

    return result.content;
  }
}
