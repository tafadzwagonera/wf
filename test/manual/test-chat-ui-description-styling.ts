// test/manual/test-chat-ui-description-styling.ts
import chalk from 'chalk';
import { ChatUIService } from '../../src/integrations/ai/conversation/chat-ui.service';
import type { ConversationMessage } from '../../src/integrations/ai/conversation/interfaces';

const service = new ChatUIService();

const mockMessage: ConversationMessage = {
  role: 'assistant',
  content: `Here is the updated plan:

## Updated Files Affected:

<descriptions>
- pricing.service.ts — Update findApplicableSpecialOffers to handle fixed amounts
- tour.service.ts — Update highest-discount selection logic to compare absolute values
</descriptions>

## Key Questions for Refinement:

<description>
Does the Lemax API currently return a discountType field on SPO objects?
</description>

Would you like to focus on the selection logic first?`,
  timestamp: new Date(),
};

console.log(
  chalk.bold('\n─── Test: <description> / <descriptions> block styling ───\n'),
);
console.log(
  chalk.dim(
    'Expected: tag lines and block content appear in CYAN. Everything else uses existing chalk styles.\n',
  ),
);

service.displayAssistantResponse(mockMessage);

console.log(
  chalk.bold('─── End of test. Verify cyan lines above. ───\n'),
);
