// test/manual/chat-ui-description-styling.smoke.ts
import chalk from 'chalk';
import type { AiService } from '../../src/integrations/ai/ai.service';
import { ChatUIService } from '../../src/integrations/ai/conversation/chat-ui.service';
import type { ConversationMessage } from '../../src/integrations/ai/conversation/interfaces';

function buildChatUIService(): ChatUIService {
  return new ChatUIService({
    getProviderShortName: () => 'AI',
  } as AiService);
}

function buildMockMessage(): ConversationMessage {
  return {
    role: 'assistant',
    content: `Here is the updated plan:

## Updated Files Affected:

- pricing.service.ts — Update findApplicableSpecialOffers to handle fixed amounts
- tour.service.ts — Update highest-discount selection logic to compare absolute values

## Key Questions for Refinement:

1. Does the Lemax API currently return a discountType field on SPO objects?
2. Should currency conversion be applied for fixed amounts?

Would you like to focus on the selection logic first?`,
    timestamp: new Date(),
  };
}

function main(): void {
  const service = buildChatUIService();
  const mockMessage = buildMockMessage();

  console.log(chalk.bold('\n─── Test: text block styling in Claude response ───\n'));
  console.log(chalk.dim('Expected: all non-empty text lines (bullets, numbered lists, plain text) appear in CYAN.\n'));

  service.displayAssistantResponse(mockMessage, 'review');

  console.log(chalk.bold('─── End of test. Verify cyan lines above. ───\n'));
}

main();
