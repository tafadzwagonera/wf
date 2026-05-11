// test/manual/test-chat-ui-description-styling.ts
import chalk from 'chalk';
import type { AiService } from '../../src/integrations/ai/ai.service';
import { ChatUIService } from '../../src/integrations/ai/conversation/chat-ui.service';
import type { ConversationMessage } from '../../src/integrations/ai/conversation/interfaces';

const service = new ChatUIService({
  getProviderShortName: () => 'AI',
} as AiService);

const mockMessage: ConversationMessage = {
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

console.log(
  chalk.bold('\n─── Test: text block styling in Claude response ───\n'),
);
console.log(
  chalk.dim(
    'Expected: all non-empty text lines (bullets, numbered lists, plain text) appear in CYAN.\n',
  ),
);

service.displayAssistantResponse(mockMessage);

console.log(chalk.bold('─── End of test. Verify cyan lines above. ───\n'));
