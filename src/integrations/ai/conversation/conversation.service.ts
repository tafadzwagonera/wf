import { Injectable } from '@nestjs/common';
import { AiService, AIConversationRequest, requireAiResponseContent } from '../ai.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { StateError } from '../../../shared/utils/errors';
import { ChatUIService } from './chat-ui.service';
import {
  ConversationMessage,
  ConversationContext,
  ConversationState,
  ChatSessionOptions,
  WorkflowStage,
} from './interfaces';
import { StageAgentService, AgentChatSession, AgentStageName } from '../stage-agent.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Build the initial ConversationState value for a new conversation.
 *
 * @param conversationId - UUID for the new conversation
 * @param ticketKey - Ticket identifier
 * @param context - Workflow context
 * @returns Fully initialised ConversationState
 */
const buildInitialState = (
  conversationId: string,
  ticketKey: string,
  context: ConversationContext
): ConversationState => {
  const now = new Date();
  return {
    conversationId, ticketKey, messages: [], context,
    totalTokensUsed: { input: 0, output: 0 }, createdAt: now, updatedAt: now,
  };
};

/**
 * Parse raw JSON file content into a ConversationState with Date objects restored.
 *
 * @param raw - Raw UTF-8 file content
 * @returns Parsed ConversationState with Date fields as Date instances
 */
const parseConversationFile = (raw: string): ConversationState => {
  const state = JSON.parse(raw) as ConversationState;
  state.createdAt = new Date(state.createdAt);
  state.updatedAt = new Date(state.updatedAt);
  for (const msg of state.messages) {
    msg.timestamp = new Date(msg.timestamp);
  }
  return state;
};

/**
 * Build the messages array suitable for the AI API from a conversation state.
 *
 * @param conversation - Current conversation state
 * @returns Array of role/content pairs
 */
const buildApiMessages = (
  conversation: ConversationState
): Array<{ role: 'user' | 'assistant'; content: string }> =>
  conversation.messages.map(msg => ({ role: msg.role, content: msg.content }));

/**
 * Apply token usage from a response to the running conversation totals.
 *
 * @param conversation - Conversation state to mutate
 * @param usage - Token counts from the API response
 */
const updateTokenCounts = (
  conversation: ConversationState,
  usage: { inputTokens: number; outputTokens: number } | undefined
): void => {
  if (!usage) return;
  conversation.totalTokensUsed.input += usage.inputTokens;
  conversation.totalTokensUsed.output += usage.outputTokens;
};

/** Resolved chat session options with maxTurns guaranteed. */
type ResolvedSessionOptions = ChatSessionOptions & { maxTurns: number };

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
    private stageAgentService: StageAgentService
  ) {}

  /**
   * Create a new conversation
   *
   * @param ticketKey - Ticket identifier
   * @param context - Workflow context for the conversation
   * @returns New conversation state
   */
  async createConversation(ticketKey: string, context: ConversationContext): Promise<ConversationState> {
    const conversationId = randomUUID();
    const state = buildInitialState(conversationId, ticketKey, context);
    this.conversations.set(conversationId, state);
    this.logger.debug(`Created conversation: ${conversationId} for ticket: ${ticketKey}`);
    return state;
  }

  /**
   * Load conversation from file system
   *
   * @param ticketKey - Ticket identifier
   * @returns Loaded conversation state or null if not found
   */
  async loadConversation(ticketKey: string, repoDir?: string, trackerName?: string): Promise<ConversationState | null> {
    const filePath = this.getConversationFilePath(ticketKey, repoDir, trackerName);
    if (!fs.existsSync(filePath)) return null;
    this.logger.debug(`Loading conversation for ticket: ${ticketKey}`);
    try {
      const state = parseConversationFile(await fs.promises.readFile(filePath, 'utf-8'));
      this.conversations.set(state.conversationId, state);
      this.logger.debug(`Loaded conversation: ${state.conversationId} for ticket: ${ticketKey}`);
      return state;
    } catch (error) {
      this.logger.error(`Failed to load conversation for ticket ${ticketKey}: ${error.message}`);
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
  async addUserMessage(conversationId: string, content: string): Promise<ConversationState> {
    const state = this.conversations.get(conversationId);

    if (!state) {
      throw new StateError(`Conversation not found: ${conversationId}`, { conversationId });
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
   * Append an assistant message to state and update token counts.
   *
   * @param state - Conversation state to mutate
   * @param content - Response text
   * @param usage - Token usage from the API response
   * @returns The newly created assistant ConversationMessage
   */
  private recordAssistantMessage(
    state: ConversationState,
    content: string,
    usage: ConversationMessage['tokenUsage']
  ): ConversationMessage {
    const assistantMessage: ConversationMessage = { role: 'assistant', content, timestamp: new Date(), tokenUsage: usage };
    state.messages.push(assistantMessage);
    state.updatedAt = new Date();
    updateTokenCounts(state, usage);
    this.logger.debug(`Assistant response added. Total tokens: ${state.totalTokensUsed.input + state.totalTokensUsed.output}`);
    return assistantMessage;
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
    stage?: WorkflowStage
  ): Promise<ConversationMessage> {
    const state = this.conversations.get(conversationId);
    if (!state) throw new StateError(`Conversation not found: ${conversationId}`, { conversationId });
    const messages = buildApiMessages(state);
    this.logger.debug(`Getting assistant response for conversation: ${conversationId} with ${messages.length} messages`);
    const stageOverride = stage ? { stage: stage as AIConversationRequest['stage'] } : {};
    const response = await this.claudeService.executeWithHistory({ messages, systemPrompt, ...stageOverride });
    const content = requireAiResponseContent(response, 'AI provider returned an empty chat response');
    return this.recordAssistantMessage(state, content, response.usage);
  }

  /**
   * Save conversation to file system
   *
   * @param state - Conversation state to save
   */
  async saveConversation(state: ConversationState): Promise<void> {
    try {
      const filePath = this.getConversationFilePath(state.ticketKey, state.context.repoDir, state.context.trackerName);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
      const tempPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
      await fs.promises.rename(tempPath, filePath);
      this.logger.debug(`Saved conversation to: ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to save conversation: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle a UI-only chat command (history/help) without consuming a turn.
   *
   * @param input - Normalised lower-case user input
   * @param state - Current conversation state
   * @returns True if the input was a handled command
   */
  private handleChatCommand(input: string, state: ConversationState): boolean {
    if (input === 'history') {
      this.chatUI.displayConversationHistory(state.messages, state.context.stage);
      return true;
    }
    if (input === 'help') {
      this.chatUI.displayHelp(state.context.stage);
      return true;
    }
    return false;
  }

  /**
   * Process one agent-backend turn and push the assistant message to state.
   *
   * @param input - User message text
   * @param state - Current conversation state
   * @param stage - Workflow stage used as agent stage name
   * @param systemPrompt - System prompt string
   * @param repoDir - Repository directory override
   * @param agentSession - Current agent session (mutated and returned)
   * @returns Updated agent session
   */
  private async processAgentTurn(
    input: string,
    state: ConversationState,
    stage: AgentStageName,
    systemPrompt: string,
    repoDir: string,
    agentSession: AgentChatSession | undefined
  ): Promise<AgentChatSession | undefined> {
    const result = await this.stageAgentService.chatTurn({
      stage, userMessage: input, systemPrompt, repoDir, session: agentSession,
    });
    const msg = this.recordAssistantMessage(state, result.content, undefined);
    this.chatUI.displayAssistantResponse(msg, state.context.stage);
    return result.session;
  }

  /**
   * Process one standard-completions turn and display the response.
   *
   * @param conversationId - Conversation identifier
   * @param state - Current conversation state
   * @param systemPrompt - System prompt string
   * @param stage - Workflow stage for provider routing
   */
  private async processStandardTurn(
    conversationId: string,
    state: ConversationState,
    systemPrompt: string | undefined,
    stage: WorkflowStage | undefined
  ): Promise<void> {
    const response = await this.getAssistantResponse(conversationId, systemPrompt, stage);
    this.chatUI.displayAssistantResponse(response, stage ?? state.context.stage);
    if (response.tokenUsage) this.chatUI.displayTokenUsage(response.tokenUsage, state.totalTokensUsed);
  }

  /**
   * Resolve whether the agent backend is enabled for the current stage.
   *
   * @param stage - Workflow stage from session options
   * @returns True when the stage-agent service is enabled for that stage
   */
  private resolveAgentBackend(stage: WorkflowStage | undefined): boolean {
    if (stage !== 'plan' && stage !== 'review') return false;
    try {
      return this.stageAgentService.isEnabledForStage(stage as AgentStageName);
    } catch {
      return false;
    }
  }

  /**
   * Dispatch a user message to the appropriate backend (agent or standard).
   *
   * @param input - User message text
   * @param conversationId - Conversation identifier
   * @param state - Current conversation state
   * @param options - Resolved session options
   * @param useAgentBackend - Whether to route through the agent SDK
   * @param agentSession - Current agent session state
   * @returns Updated agent session
   */
  private async dispatchTurn(
    input: string, conversationId: string, state: ConversationState,
    options: ResolvedSessionOptions,
    useAgentBackend: boolean, agentSession: AgentChatSession | undefined
  ): Promise<AgentChatSession | undefined> {
    if (useAgentBackend) {
      return this.processAgentTurn(
        input, state, options.stage as AgentStageName,
        options.systemPrompt ?? '', options.repoDir ?? state.context.repoDir ?? '', agentSession
      );
    }
    await this.processStandardTurn(conversationId, state, options.systemPrompt, options.stage);
    return agentSession;
  }

  /**
   * Execute a single chat loop iteration; return the updated agent session and whether to break.
   *
   * @param turn - Current turn number
   * @param conversationId - Conversation identifier
   * @param state - Current conversation state
   * @param options - Resolved session options
   * @param useAgentBackend - Whether to route through the agent SDK
   * @param agentSession - Current agent session
   * @returns Object with updated session and exit flag
   */
  private async executeTurn(
    turn: number, conversationId: string, state: ConversationState,
    options: ResolvedSessionOptions,
    useAgentBackend: boolean, agentSession: AgentChatSession | undefined
  ): Promise<{ session: AgentChatSession | undefined; exit: boolean; skip: boolean }> {
    const { input, shouldExit } = await this.chatUI.promptUserInput(turn, options.maxTurns);
    this.logger.debug(shouldExit ? 'User requested to exit chat session' : `Processing turn ${turn}`);
    if (shouldExit) return { session: agentSession, exit: true, skip: false };
    if (this.handleChatCommand(input.toLowerCase(), state)) return { session: agentSession, exit: false, skip: true };
    await this.addUserMessage(conversationId, input);
    const session = await this.dispatchTurn(input, conversationId, state, options, useAgentBackend, agentSession);
    await this.saveConversation(state);
    return { session, exit: false, skip: false };
  }

  /**
   * Run the chat loop, processing turns until exit or max turns reached.
   *
   * @param conversationId - Conversation identifier
   * @param state - Current conversation state
   * @param options - Resolved session options
   * @param useAgentBackend - Whether to route turns through the agent SDK
   * @returns Final turn count
   */
  private onTurnError(error: Error): void {
    this.logger.error(`Error in chat session: ${error.message}`);
    this.chatUI.displayError(`Failed to process message: ${error.message}`);
  }

  private async runChatLoop(
    conversationId: string, state: ConversationState,
    options: ResolvedSessionOptions, useAgentBackend: boolean, initialAgentSession?: AgentChatSession
  ): Promise<number> {
    let agentSession: AgentChatSession | undefined = initialAgentSession, turn = 1;
    while (turn <= options.maxTurns) {
      try {
        const result = await this.executeTurn(turn, conversationId, state, options, useAgentBackend, agentSession);
        if (result.exit) break;
        agentSession = result.session;
        turn += result.skip ? 0 : 1;
      } catch (error) { this.onTurnError(error as Error); }
    }
    return turn;
  }

  /**
   * Start interactive chat session
   *
   * @param conversationId - Conversation identifier
   * @param options - Chat session options
   */
  async startChatSession(conversationId: string, options?: ChatSessionOptions): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) throw new StateError(`Conversation not found: ${conversationId}`, { conversationId });
    const resolvedOptions = { maxTurns: 20, ...options };
    const useAgentBackend = this.resolveAgentBackend(resolvedOptions.stage);
    const initialAgentSession = useAgentBackend && resolvedOptions.resumeProviderSessionId
      ? this.buildSeedAgentSession(resolvedOptions.resumeProviderSessionId)
      : undefined;
    this.chatUI.displayChatIntro(state.context.stage, state.context);
    const turn = await this.runChatLoop(conversationId, state, resolvedOptions, useAgentBackend, initialAgentSession);
    if (turn > resolvedOptions.maxTurns) this.chatUI.displayMaxTurnsReached(resolvedOptions.maxTurns);
    await this.saveConversation(state);
    const filePath = this.getConversationFilePath(state.ticketKey, state.context.repoDir, state.context.trackerName);
    this.chatUI.displayChatEnd(filePath);
  }

  /**
   * Build a minimal agent session that carries only the provider session ID for resumption.
   * The provider field is metadata — chatTurn re-resolves the actual provider from stage
   * config at stage-agent.service.ts:1370, so the value here does not affect routing.
   *
   * @param sessionId - Provider session ID from the initial review pass
   * @returns Seed AgentChatSession with sessionId populated
   */
  private buildSeedAgentSession(sessionId: string): AgentChatSession {
    return { provider: 'anthropic', sessionId };
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
  private getConversationFilePath(ticketKey: string, repoDir?: string, trackerName?: string): string {
    const baseDir = repoDir ?? process.cwd();
    const segments: string[] = [os.homedir(), '.wf', path.basename(path.resolve(baseDir))];
    if (trackerName) {
      segments.push(trackerName);
    }
    return path.join(...segments, `${ticketKey}-conversation.json`);
  }
}
