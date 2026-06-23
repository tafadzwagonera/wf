/**
 * Manual Test: provider-aware empty AI response diagnostics
 *
 * Run: nr test:manual -- test-empty-ai-response-diagnostics
 *
 * Verifies that blank AI outputs fail fast with provider/model-aware errors
 * across standard stage methods, agent-backed stage methods, chat, and the
 * issue:generate clarification path.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { ConfigService } from '@nestjs/config';
import type { ConversationContext } from '../../src/integrations/ai/conversation/interfaces';

async function testEmptyAiResponseDiagnostics() {
  console.log(
    '\n🧪 Manual Test: provider-aware empty AI response diagnostics\n',
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (message: string) => {
    console.log(`  ✓ ${message}`);
    passed++;
  };

  const fail = (message: string, detail?: string) => {
    console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
    failed++;
  };
  const passWhen = (
    condition: boolean,
    successMessage: string,
    failureMessage: string,
    detail?: string,
  ) => {
    if (condition) {
      pass(successMessage);
      return;
    }

    fail(failureMessage, detail);
  };

  const aiService = app.get(AiService);
  const stageAgentService = app.get(StageAgentService);
  const conversationService = app.get(ConversationService);
  const originalExecute = AiService.prototype.execute;
  const originalExecuteWithHistory = AiService.prototype.executeWithHistory;
  const originalRunStagePrompt = (stageAgentService as any).runStagePrompt;
  try {
    // Test 1: standard plan path
    (AiService.prototype as any).execute = async () => ({
      content: '',
      provider: 'openai',
      model: 'gpt-5.4',
      finishReason: 'stop',
    });

    try {
      await aiService.generatePlan('fix', '# TEST-1: Blank plan response');
      fail('AiService.generatePlan should reject blank output');
    } catch (error: any) {
      const hasExpectedError =
        error?.message === 'AI provider returned an empty plan response' &&
        error?.details?.provider === 'openai' &&
        error?.details?.model === 'gpt-5.4';
      passWhen(
        hasExpectedError,
        'AiService.generatePlan reports provider-aware blank-plan errors',
        'AiService.generatePlan returned the wrong error shape',
        error?.message ?? String(error),
      );
    }

    // Test 2: agent-backed generate path
    (stageAgentService as any).runStagePrompt = async () => '   ';

    try {
      await stageAgentService.generateFromPrompt('Summarise this source');
      fail('StageAgentService.generateFromPrompt should reject blank output');
    } catch (error: any) {
      const hasExpectedError =
        error?.message ===
          'AI provider returned an empty generated content response' &&
        error?.details?.provider &&
        error?.details?.model;
      passWhen(
        hasExpectedError,
        'StageAgentService.generateFromPrompt reports provider-aware blank generate errors',
        'StageAgentService.generateFromPrompt returned the wrong error shape',
        error?.message ?? String(error),
      );
    }

    // Test 3: standard chat path
    const conversationContext: ConversationContext = {
      ticketKey: 'TEST-CHAT',
      stage: 'review',
      workflowState: {
        ticketContent: 'Chat test ticket content',
      },
    };
    const conversation = await conversationService.createConversation(
      'TEST-CHAT',
      conversationContext,
    );
    await conversationService.addUserMessage(
      conversation.conversationId,
      'Why did the stage fail?',
    );

    (AiService.prototype as any).executeWithHistory = async () => ({
      content: '',
      provider: 'openai',
      model: 'gpt-5.4',
    });

    try {
      await conversationService.getAssistantResponse(
        conversation.conversationId,
      );
      fail(
        'ConversationService.getAssistantResponse should reject blank output',
      );
    } catch (error: any) {
      const hasExpectedError =
        error?.message === 'AI provider returned an empty chat response' &&
        error?.details?.provider === 'openai' &&
        error?.details?.model === 'gpt-5.4';
      passWhen(
        hasExpectedError,
        'ConversationService.getAssistantResponse reports provider-aware blank chat errors',
        'ConversationService.getAssistantResponse returned the wrong error shape',
        error?.message ?? String(error),
      );
    }

    // Test 4: issue:generate clarification path
    const mockClarificationAiService = {
      execute: async () => ({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    };
    const mockClarificationConfigService = {
      get: () => 'jira',
    };
    const mockClarificationStageAgentService = {
      isEnabledForStage: () => false,
    };
    const clarificationCommand = new IssueGenerateCommand(
      {} as any,
      {} as any,
      mockClarificationAiService as unknown as AiService,
      mockClarificationConfigService as unknown as ConfigService,
      {} as any,
      {} as any,
      {} as any,
      mockClarificationStageAgentService as unknown as StageAgentService,
    );

    try {
      await (clarificationCommand as any).identifyClarifications([
        {
          type: 'file',
          source: 'manual-source.md',
          content: 'Plain source content for clarification.',
        },
      ]);
      fail('issue:generate clarification stage should reject blank output');
    } catch (error: any) {
      const hasExpectedError =
        error?.message ===
          'AI provider returned an empty clarification response' &&
        error?.details?.provider === 'openai' &&
        error?.details?.model === 'gpt-5.4';
      passWhen(
        hasExpectedError,
        'issue:generate clarification stage surfaces provider-aware blank-output errors',
        'issue:generate clarification stage returned the wrong error shape',
        error?.message ?? String(error),
      );
    }
  } finally {
    AiService.prototype.execute = originalExecute;
    AiService.prototype.executeWithHistory = originalExecuteWithHistory;
    (stageAgentService as any).runStagePrompt = originalRunStagePrompt;
    await app.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }

  process.exit(0);
}

void testEmptyAiResponseDiagnostics();
