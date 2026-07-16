import { Injectable } from '@nestjs/common';
import { createPromptModule } from 'inquirer';
import chalk from 'chalk';
import { ConversationMessage, ConversationContext, WorkflowStage } from './interfaces';
import { AiService, REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../ai.service';

/**
 * Format the header line for a chat intro given a stage and provider name.
 *
 * @param stage - Current workflow stage
 * @param provider - Short provider name
 * @returns Formatted header string
 */
const formatIntroHeader = (stage: WorkflowStage, provider: string): string =>
  `Current Stage: ${stage.toUpperCase()} | Provider: ${provider}`;

/**
 * Build the inquirer prompt message for a given turn.
 *
 * @param turnNumber - Current turn number
 * @param turnsLeft - Remaining turns
 * @param maxTurns - Maximum allowed turns
 * @returns Formatted chalk prompt string
 */
const buildPromptMessage = (turnNumber: number, turnsLeft: number, maxTurns: number): string =>
  chalk.cyan(`💬 You [${turnsLeft} turns left (${turnNumber}/${maxTurns})]:`);

/**
 * Format a single line of assistant response content.
 *
 * @param line - Raw content line
 * @returns Formatted string with chalk colour
 */
const formatResponseLine = (line: string): string => {
  const trimmed = line.trim();
  if (trimmed.startsWith('```')) return chalk.dim(line);
  if (trimmed.startsWith('-') || trimmed.startsWith('*')) return chalk.cyan(line);
  if (/^\d+\./.exec(trimmed)) return chalk.cyan(line);
  if (trimmed.length > 0) return chalk.cyan(line);
  return line;
};

/**
 * Format a single token count display line.
 *
 * @param label - Display label
 * @param count - Token count value
 * @returns Formatted chalk dim string
 */
const formatTokenLine = (label: string, count: number): string => chalk.dim(`${label}: ${count}`);

/**
 * Format a single history entry for display.
 *
 * @param msg - Conversation message
 * @param index - Zero-based message index
 * @param providerName - Short provider name
 * @returns Formatted prefix string for that message role
 */
const formatHistoryEntry = (msg: ConversationMessage, index: number, providerName: string): string =>
  msg.role === 'user'
    ? chalk.cyan(`💬 You [${index + 1}]:`)
    : chalk.magenta(`🤖 ${providerName} [${index + 1}]:`);

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
    const provider = this.aiService.getProviderShortName();
    console.log(chalk.bold.cyan('\n💬 Interactive Chat Mode'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log(chalk.gray(`You can now discuss the output with ${provider}. Type "exit" to continue.`));
    console.log();
    console.log(chalk.dim('Commands: Type your question, "history", "help", or "exit"'));
    console.log();
    console.log(chalk.gray('━'.repeat(70)));
    console.log(chalk.bold(formatIntroHeader(stage, provider)));
    if (context.stageOutput) this.displayStageContext(stage, context.stageOutput);
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
        console.log(chalk.dim(`Complexity: ${output.estimatedComplexity.toUpperCase()}`));
      }
    } else if (stage === 'review' && output.summary) {
      console.log(chalk.dim(`Review Summary: ${output.summary}`));
      if (output.approved !== undefined) {
        const status = output.approved ? `✓ ${REVIEW_VERDICT_APPROVED}` : `✗ ${REVIEW_VERDICT_CHANGES_REQUESTED}`;
        const color = output.approved ? chalk.green : chalk.red;
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
  async promptUserInput(conversationTurn: number, maxTurns: number): Promise<{ input: string; shouldExit: boolean }> {
    const turnsLeft = maxTurns - conversationTurn;
    const answer = await this.inquirer({
      type: 'input',
      name: 'message',
      prefix: ' ',
      message: buildPromptMessage(conversationTurn, turnsLeft, maxTurns),
      validate: (input: string) => input.trim() ? true : 'Please enter a message or command',
    });

    const input = answer.message.trim();
    return { input, shouldExit: this.isExitCommand(input) };
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
    console.log(chalk.bold.magenta(`🤖 ${this.aiService.getProviderShortName()}:`));
    console.log();
    for (const line of message.content.split('\n')) console.log(formatResponseLine(line));
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
    totalUsage: { input: number; output: number }
  ): void {
    const current = currentUsage.inputTokens + currentUsage.outputTokens;
    const conversationTotal = totalUsage.input + totalUsage.output;
    console.log(formatTokenLine(
      `📊 Tokens: Input: ${currentUsage.inputTokens} | Output: ${currentUsage.outputTokens} | Total`,
      current
    ));
    console.log(chalk.dim(
      `   Conversation Total: ${conversationTotal} (${totalUsage.input} in, ${totalUsage.output} out)`
    ));
    console.log();
  }

  /**
   * Render a single history message to the console.
   *
   * @param msg - Conversation message to render
   * @param index - Zero-based message index
   * @param provider - Short provider name
   */
  private renderHistoryMessage(msg: ConversationMessage, index: number, provider: string): void {
    const preview = msg.content.length > 150 ? `${msg.content.substring(0, 150)}...` : msg.content;
    console.log();
    console.log(formatHistoryEntry(msg, index, provider));
    console.log(chalk.dim(`  ${msg.timestamp.toLocaleString()}`));
    console.log(`  ${preview}`);
    if (msg.tokenUsage) console.log(chalk.dim(`  Tokens: ${msg.tokenUsage.inputTokens + msg.tokenUsage.outputTokens}`));
  }

  /**
   * Display conversation history
   *
   * @param messages - All conversation messages
   */
  displayConversationHistory(messages: ConversationMessage[]): void {
    const provider = this.aiService.getProviderShortName();
    const sep = chalk.gray('─'.repeat(70));
    console.log(`\n${chalk.bold.cyan('📜 Conversation History')}\n${sep}`);
    if (messages.length === 0) console.log(chalk.dim('No messages yet'));
    for (const [index, msg] of messages.entries()) this.renderHistoryMessage(msg, index, provider);
    console.log(`\n${sep}\n`);
  }

  /**
   * Display help information
   */
  displayHelp(): void {
    const provider = this.aiService.getProviderShortName();
    const sep = chalk.gray('─'.repeat(70));
    console.log(`\n${chalk.bold.cyan('💡 Chat Commands')}\n${sep}\n`);
    console.log(chalk.white(`  • Type any question or message to chat with ${provider}`));
    console.log(chalk.white('  • "history" - View conversation history'));
    console.log(chalk.white('  • "help" - Show this help message'));
    console.log(chalk.white('  • "exit", "quit", "continue" - End chat and resume workflow'));
    console.log();
    console.log(chalk.dim(`  - Ask ${provider} to explain steps in more detail`));
    console.log(chalk.dim('  - Discuss potential issues or alternative approaches'));
    console.log(chalk.dim('  - Request clarification on review findings'));
    console.log(`\n${sep}\n`);
  }

  /**
   * Display chat session end message
   *
   * @param filePath - Path to saved conversation file
   */
  displayChatEnd(filePath: string): void {
    console.log();
    console.log(chalk.green(`✓ Chat session saved to: ${chalk.bold(filePath)}`));
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
    console.log(chalk.yellow(`⚠️ Maximum conversation turns (${maxTurns}) reached. Ending chat session.`));
    console.log();
  }
}
