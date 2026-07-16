import { Injectable } from '@nestjs/common';
import { AiService, requireAiResponseContent } from '../../integrations/ai/ai.service';

interface GenerateCommitMessageOptions {
  diff: string;
  ticketKey?: string;
  conventional?: boolean;
  commitHistory?: string[];
  ticketContext?: string;
}

@Injectable()
export class CommitStageService {
  constructor(private readonly aiService: AiService) {}

  async generateCommitMessage(options: GenerateCommitMessageOptions): Promise<string> {
    if (options.commitHistory || options.ticketContext) {
      const rawMessage = await this.aiService.generateCommitMessage(
        options.diff,
        options.commitHistory ?? [],
        'auto',
        options.ticketContext
      );
      return this.normalizeCommitMessage(rawMessage, options.ticketKey);
    }

    const prompt = this.buildCommitPrompt(options.diff, options.ticketKey, options.conventional);
    const response = await this.aiService.execute({
      prompt,
      maxTokens: 500,
      temperature: 0.7,
      stage: 'commit',
    });
    return this.normalizeCommitMessage(
      requireAiResponseContent(response, 'AI provider returned an empty commit message response'),
      options.ticketKey,
      false
    );
  }

  private normalizeCommitMessage(
    rawMessage: string,
    ticketKey?: string,
    stripConventionalPrefix: boolean = true
  ): string {
    let message = rawMessage.trim();
    message = message
      .replaceAll(/```[a-z]*\n?/g, '')
      .replaceAll('```', '')
      .trim();

    if (stripConventionalPrefix) {
      message = message.replace(/^[a-z]+(\([^)]+\))?:\s*/, '').replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, '');
    }

    if (ticketKey && !message.includes(ticketKey)) {
      return `${ticketKey}: ${message}`;
    }

    return message;
  }

  private buildCommitPrompt(diff: string, ticketKey?: string, conventional?: boolean): string {
    let prompt = 'Generate a concise, informative git commit message for the following changes.\n\n';

    if (conventional) {
      prompt += 'Use conventional commits format: <type>(<scope>): <description>\n';
      prompt += 'Types: feat, fix, docs, style, refactor, test, chore\n\n';
    }

    if (ticketKey) {
      prompt += `Related ticket: ${ticketKey}\n\n`;
    }

    prompt += 'Guidelines:\n';
    prompt += '- First line: concise summary (50 chars or less)\n';
    prompt += '- Focus on WHY and WHAT, not HOW\n';
    prompt += '- Use imperative mood ("Add feature" not "Added feature")\n';
    prompt += '- Be specific and clear\n';
    prompt += '- Do not include the ticket key (will be added automatically)\n\n';
    prompt += 'Git diff:\n';
    prompt += `\`\`\`diff\n${diff.substring(0, 3000)}\n\`\`\`\n\n`;
    prompt += 'Return only the commit message, no explanations.';

    return prompt;
  }
}
