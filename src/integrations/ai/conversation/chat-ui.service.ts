import { Injectable } from '@nestjs/common';
import { createPromptModule } from 'inquirer';
import chalk from 'chalk';
import {
  ConversationMessage,
  ConversationContext,
  WorkflowStage,
} from './interfaces';
import { AiService } from '../ai.service';

/**
 * Service for handling CLI UI for interactive chat sessions
 *
 * Manages user input, message display, and formatting for
 * terminal-based conversations with the configured AI provider.
 */
@Injectable()
export class ChatUIService {
  private inquirer = createPromptModule();

  constructor(private readonly aiService: AiService) {}

  /**
   * Display introduction to chat session with context
   *
   * @param stage - Current workflow stage
   * @param context - Conversation context
   */
  displayChatIntro(stage: WorkflowStage, context: ConversationContext): void {
    console.log(chalk.bold.cyan('\n💬 Interactive Chat Mode'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log(
      chalk.gray(
        `You can now discuss the output with ${this.aiService.getProviderShortName()}. Type "exit" to continue.`,
      ),
    );
    console.log();
    console.log(
      chalk.dim('Commands: Type your question, "history", "help", or "exit"'),
    );
    console.log();
    console.log(chalk.gray('━'.repeat(70)));
    console.log(chalk.bold(`Current Stage: ${stage.toUpperCase()}`));

    if (context.stageOutput) {
      this.displayStageContext(stage, context.stageOutput);
    }

    console.log(chalk.gray('━'.repeat(70)));
    console.log();
  }

  /**
   * Display stage-specific context information
   *
   * @param stage - Workflow stage
   * @param output - Stage output data
   */
  private displayStageContext(stage: WorkflowStage, output: any): void {
    if (stage === 'plan' && output.summary) {
      console.log(chalk.dim(`Plan Summary: ${output.summary}`));
      if (output.estimatedComplexity) {
        console.log(
          chalk.dim(`Complexity: ${output.estimatedComplexity.toUpperCase()}`),
        );
      }
    } else if (stage === 'review' && output.summary) {
      console.log(chalk.dim(`Review Summary: ${output.summary}`));
      if (output.approved !== undefined) {
        const status = output.approved ? '✓ Approved' : '⚠️ Needs Work';
        const color = output.approved ? chalk.green : chalk.yellow;
        console.log(color(status));
      }
    }
  }

  /**
   * Prompt user for input
   *
   * @param conversationTurn - Current turn number
   * @param maxTurns - Maximum turns allowed
   * @returns User input and exit flag
   */
  async promptUserInput(
    conversationTurn: number,
    maxTurns: number,
  ): Promise<{ input: string; shouldExit: boolean }> {
    const turnsLeft = maxTurns - conversationTurn;
    const answer = await this.inquirer({
      type: 'input',
      name: 'message',
      message: chalk.cyan(
        `💬 You [${turnsLeft} turns left (${conversationTurn}/${maxTurns})]:`,
      ),
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Please enter a message or command';
        }
        return true;
      },
    });

    const input = answer.message.trim();
    const shouldExit = this.isExitCommand(input);

    return { input, shouldExit };
  }

  /**
   * Check if input is an exit command
   *
   * @param input - User input
   * @returns True if exit command
   */
  private isExitCommand(input: string): boolean {
    const exitCommands = ['exit', 'quit', 'continue'];
    return exitCommands.includes(input.toLowerCase());
  }

  /**
   * Display assistant response with formatting
   *
   * @param message - Assistant message
   */
  displayAssistantResponse(message: ConversationMessage): void {
    console.log();
    console.log(
      chalk.bold.magenta(`🤖 ${this.aiService.getProviderShortName()}:`),
    );
    console.log();

    // Split content into lines and format
    const lines = message.content.split('\n');
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        // Highlight code blocks
        console.log(chalk.dim(line));
      } else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        // Highlight bullet points
        console.log(chalk.cyan(line));
      } else if (trimmed.match(/^\d+\./)) {
        // Highlight numbered lists
        console.log(chalk.cyan(line));
      } else if (trimmed.length > 0) {
        // Highlight all other non-empty text
        console.log(chalk.cyan(line));
      } else {
        console.log(line);
      }
    });

    console.log();
  }

  /**
   * Display token usage statistics
   *
   * @param currentUsage - Token usage for current message
   * @param totalUsage - Total token usage for conversation
   */
  displayTokenUsage(
    currentUsage: { inputTokens: number; outputTokens: number },
    totalUsage: { input: number; output: number },
  ): void {
    const current = currentUsage.inputTokens + currentUsage.outputTokens;

    console.log(
      chalk.dim(
        `📊 Tokens: Input: ${currentUsage.inputTokens} | Output: ${currentUsage.outputTokens} | Total: ${current}`,
      ),
    );
    console.log(
      chalk.dim(
        `   Conversation Total: ${totalUsage.input + totalUsage.output} (${totalUsage.input} in, ${totalUsage.output} out)`,
      ),
    );
    console.log();
  }

  /**
   * Display conversation history
   *
   * @param messages - All conversation messages
   */
  displayConversationHistory(messages: ConversationMessage[]): void {
    console.log();
    console.log(chalk.bold.cyan('📜 Conversation History'));
    console.log(chalk.gray('─'.repeat(70)));

    if (messages.length === 0) {
      console.log(chalk.dim('No messages yet'));
    } else {
      messages.forEach((msg, index) => {
        const prefix =
          msg.role === 'user'
            ? chalk.cyan(`💬 You [${index + 1}]:`)
            : chalk.magenta(
                `🤖 ${this.aiService.getProviderShortName()} [${index + 1}]:`,
              );

        console.log();
        console.log(prefix);
        console.log(chalk.dim(`  ${msg.timestamp.toLocaleString()}`));

        // Truncate long messages for history view
        const preview =
          msg.content.length > 150
            ? msg.content.substring(0, 150) + '...'
            : msg.content;

        console.log(`  ${preview}`);

        if (msg.tokenUsage) {
          console.log(
            chalk.dim(
              `  Tokens: ${msg.tokenUsage.inputTokens + msg.tokenUsage.outputTokens}`,
            ),
          );
        }
      });
    }

    console.log();
    console.log(chalk.gray('─'.repeat(70)));
    console.log();
  }

  /**
   * Display help information
   */
  displayHelp(): void {
    console.log();
    console.log(chalk.bold.cyan('💡 Chat Commands'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log();
    console.log(
      chalk.white(
        `  • Type any question or message to chat with ${this.aiService.getProviderShortName()}`,
      ),
    );
    console.log(chalk.white('  • "history" - View conversation history'));
    console.log(chalk.white('  • "help" - Show this help message'));
    console.log(
      chalk.white(
        '  • "exit", "quit", "continue" - End chat and resume workflow',
      ),
    );
    console.log();
    console.log(chalk.dim('Tips:'));
    console.log(
      chalk.dim(
        `  - Ask ${this.aiService.getProviderShortName()} to explain steps in more detail`,
      ),
    );
    console.log(
      chalk.dim('  - Discuss potential issues or alternative approaches'),
    );
    console.log(chalk.dim('  - Request clarification on review findings'));
    console.log();
    console.log(chalk.gray('─'.repeat(70)));
    console.log();
  }

  /**
   * Display chat session end message
   *
   * @param filePath - Path to saved conversation file
   */
  displayChatEnd(filePath: string): void {
    console.log();
    console.log(
      chalk.green(`✓ Chat session saved to: ${chalk.bold(filePath)}`),
    );
    console.log(chalk.green('✓ Resuming workflow...'));
    console.log();
  }

  /**
   * Display error message
   *
   * @param message - Error message
   */
  displayError(message: string): void {
    console.log();
    console.log(chalk.red(`❌ Error: ${message}`));
    console.log();
  }

  /**
   * Display warning message
   *
   * @param message - Warning message
   */
  displayWarning(message: string): void {
    console.log();
    console.log(chalk.yellow(`⚠️ Warning: ${message}`));
    console.log();
  }

  /**
   * Display max turns reached message
   *
   * @param maxTurns - Maximum turns allowed
   */
  displayMaxTurnsReached(maxTurns: number): void {
    console.log();
    console.log(
      chalk.yellow(
        `⚠️ Maximum conversation turns (${maxTurns}) reached. Ending chat session.`,
      ),
    );
    console.log();
  }
}
