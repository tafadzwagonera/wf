import { Injectable } from '@nestjs/common';
import { AiService, AIConversationRequest } from '../ai.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ChatUIService } from './chat-ui.service';
import {
  ConversationMessage,
  ConversationContext,
  ConversationState,
  ChatSessionOptions,
  WorkflowStage,
} from './interfaces';
import {
  StageAgentService,
  AgentChatSession,
  AgentStageName,
} from '../stage-agent.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Service for managing multi-turn conversations with Claude
 *
 * Handles conversation state, history management, and orchestration
 * of chat sessions. Conversations are persisted to disk and can be
 * resumed across command invocations.
 */
@Injectable()
export class ConversationService {
  // In-memory storage of active conversations
  private conversations = new Map<string, ConversationState>();

  constructor(
    private claudeService: AiService,
    private chatUI: ChatUIService,
    private logger: LoggerService,
    private stageAgentService: StageAgentService,
  ) {}

  /**
   * Create a new conversation
   *
   * @param ticketKey - Ticket identifier
   * @param context - Workflow context for the conversation
   * @returns New conversation state
   */
  async createConversation(
    ticketKey: string,
    context: ConversationContext,
  ): Promise<ConversationState> {
    const conversationId = randomUUID();
    const now = new Date();

    const state: ConversationState = {
      conversationId,
      ticketKey,
      messages: [],
      context,
      totalTokensUsed: {
        input: 0,
        output: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.conversations.set(conversationId, state);
    this.logger.debug(
      `Created conversation: ${conversationId} for ticket: ${ticketKey}`,
    );

    return state;
  }

  /**
   * Load conversation from file system
   *
   * @param ticketKey - Ticket identifier
   * @returns Loaded conversation state or null if not found
   */
  async loadConversation(
    ticketKey: string,
    repoDir?: string,
    trackerName?: string,
  ): Promise<ConversationState | null> {
    try {
      const filePath = this.getConversationFilePath(
        ticketKey,
        repoDir,
        trackerName,
      );

      if (!fs.existsSync(filePath)) {
        this.logger.debug(
          `No conversation file found for ticket: ${ticketKey}`,
        );
        return null;
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const state = JSON.parse(content) as ConversationState;

      // Parse Date objects
      state.createdAt = new Date(state.createdAt);
      state.updatedAt = new Date(state.updatedAt);
      state.messages.forEach((msg) => {
        msg.timestamp = new Date(msg.timestamp);
      });

      // Store in memory
      this.conversations.set(state.conversationId, state);
      this.logger.debug(
        `Loaded conversation: ${state.conversationId} for ticket: ${ticketKey}`,
      );

      return state;
    } catch (error) {
      this.logger.error(
        `Failed to load conversation for ticket ${ticketKey}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Add user message to conversation
   *
   * @param conversationId - Conversation identifier
   * @param content - Message content
   * @returns Updated conversation state
   */
  async addUserMessage(
    conversationId: string,
    content: string,
  ): Promise<ConversationState> {
    const state = this.conversations.get(conversationId);

    if (!state) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const message: ConversationMessage = {
      role: 'user',
      content,
      timestamp: new Date(),
    };

    state.messages.push(message);
    state.updatedAt = new Date();

    this.logger.debug(`Added user message to conversation: ${conversationId}`);

    return state;
  }

  /**
   * Get assistant response using Claude API
   *
   * @param conversationId - Conversation identifier
   * @param systemPrompt - Optional system prompt for context
   * @returns Assistant message with response
   */
  async getAssistantResponse(
    conversationId: string,
    systemPrompt?: string,
    stage?: WorkflowStage,
  ): Promise<ConversationMessage> {
    const state = this.conversations.get(conversationId);

    if (!state) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // Build messages array for API
    const messages = state.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    this.logger.debug(
      `Getting assistant response for conversation: ${conversationId} with ${messages.length} messages`,
    );

    // Call Claude with full history
    const response = await this.claudeService.executeWithHistory({
      messages,
      systemPrompt,
      ...(stage ? { stage: stage as AIConversationRequest['stage'] } : {}),
    });

    // Create assistant message
    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: response.content,
      timestamp: new Date(),
      tokenUsage: response.usage,
    };

    // Update state
    state.messages.push(assistantMessage);
    state.updatedAt = new Date();

    if (response.usage) {
      state.totalTokensUsed.input += response.usage.inputTokens;
      state.totalTokensUsed.output += response.usage.outputTokens;
    }

    this.logger.debug(
      `Assistant response added. Total tokens: ${state.totalTokensUsed.input + state.totalTokensUsed.output}`,
    );

    return assistantMessage;
  }

  /**
   * Save conversation to file system
   *
   * @param state - Conversation state to save
   */
  async saveConversation(state: ConversationState): Promise<void> {
    try {
      const filePath = this.getConversationFilePath(
        state.ticketKey,
        state.context.repoDir,
        state.context.trackerName,
      );
      const dir = path.dirname(filePath);

      // Ensure directory exists
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      // Write with atomic operation (temp file + rename)
      const tempPath = `${filePath}.tmp`;
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify(state, null, 2),
        'utf-8',
      );
      await fs.promises.rename(tempPath, filePath);

      this.logger.debug(`Saved conversation to: ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to save conversation: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start interactive chat session
   *
   * @param conversationId - Conversation identifier
   * @param options - Chat session options
   */
  async startChatSession(
    conversationId: string,
    options?: ChatSessionOptions,
  ): Promise<void> {
    const state = this.conversations.get(conversationId);

    if (!state) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const { systemPrompt, maxTurns = 20, stage, repoDir } = options || {};

    const isAgentStage = stage === 'plan' || stage === 'review';
    let useAgentBackend = false;
    if (isAgentStage) {
      try {
        useAgentBackend = this.stageAgentService.isEnabledForStage(
          stage as AgentStageName,
        );
      } catch {
        // Unsupported provider for agent mode — fall back to standard
      }
    }

    let agentSession: AgentChatSession | undefined;

    // Display intro
    this.chatUI.displayChatIntro(state.context.stage, state.context);

    let turn = 1;

    while (turn <= maxTurns) {
      try {
        // Get user input
        const { input, shouldExit } = await this.chatUI.promptUserInput(turn);

        // Handle special commands
        if (shouldExit) {
          this.logger.debug('User requested to exit chat session');
          break;
        }

        if (input.toLowerCase() === 'history') {
          this.chatUI.displayConversationHistory(state.messages);
          continue; // Don't increment turn for command
        }

        if (input.toLowerCase() === 'help') {
          this.chatUI.displayHelp();
          continue; // Don't increment turn for command
        }

        // Add user message
        await this.addUserMessage(conversationId, input);

        if (useAgentBackend) {
          const result = await this.stageAgentService.chatTurn({
            stage: stage as AgentStageName,
            userMessage: input,
            systemPrompt: systemPrompt ?? '',
            repoDir: repoDir ?? state.context.repoDir,
            session: agentSession,
          });
          agentSession = result.session;

          const assistantMessage: ConversationMessage = {
            role: 'assistant',
            content: result.content,
            timestamp: new Date(),
          };
          state.messages.push(assistantMessage);
          state.updatedAt = new Date();
          this.chatUI.displayAssistantResponse(assistantMessage);
        } else {
          // Get assistant response via standard completions
          const response = await this.getAssistantResponse(
            conversationId,
            systemPrompt,
            stage,
          );

          // Display response
          this.chatUI.displayAssistantResponse(response);

          // Display token usage
          if (response.tokenUsage) {
            this.chatUI.displayTokenUsage(
              response.tokenUsage,
              state.totalTokensUsed,
            );
          }
        }

        // Save conversation after each exchange
        await this.saveConversation(state);

        turn++;
      } catch (error) {
        this.logger.error(`Error in chat session: ${error.message}`);
        this.chatUI.displayError(`Failed to process message: ${error.message}`);
        // Continue the loop to allow recovery
      }
    }

    if (turn > maxTurns) {
      this.chatUI.displayMaxTurnsReached(maxTurns);
    }

    // Final save
    await this.saveConversation(state);

    // Display end message
    const filePath = this.getConversationFilePath(
      state.ticketKey,
      state.context.repoDir,
      state.context.trackerName,
    );
    this.chatUI.displayChatEnd(filePath);
  }

  /**
   * Get conversation from memory
   *
   * @param conversationId - Conversation identifier
   * @returns Conversation state or undefined if not found
   */
  getConversation(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * Get file path for conversation storage
   *
   * @param ticketKey - Ticket identifier
   * @returns Full path to conversation JSON file
   */
  private getConversationFilePath(
    ticketKey: string,
    repoDir?: string,
    trackerName?: string,
  ): string {
    if (repoDir) {
      const segments = [
        os.homedir(),
        '.wf',
        path.basename(path.resolve(repoDir)),
      ];
      if (trackerName) {
        segments.push(trackerName);
      }
      return path.join(...segments, `${ticketKey}-conversation.json`);
    }
    return path.join(process.cwd(), 'jira', `${ticketKey}-conversation.json`);
  }
}
