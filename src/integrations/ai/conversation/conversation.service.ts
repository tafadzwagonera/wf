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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWfHomeDir } from '../../../shared/utils/wf-paths';
import { randomUUID } from 'node:crypto';

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

const parseConversationFile = (raw: string): ConversationState => {
  const state = JSON.parse(raw) as ConversationState;
  state.createdAt = new Date(state.createdAt);
  state.updatedAt = new Date(state.updatedAt);
  for (const msg of state.messages) {
    msg.timestamp = new Date(msg.timestamp);
  }
  return state;
};

const buildApiMessages = (
  conversation: ConversationState
): Array<{ role: 'user' | 'assistant'; content: string }> =>
  conversation.messages.map(msg => ({ role: msg.role, content: msg.content }));

const updateTokenCounts = (
  conversation: ConversationState,
  usage: { inputTokens: number; outputTokens: number } | undefined
): void => {
  if (!usage) return;
  conversation.totalTokensUsed.input += usage.inputTokens;
  conversation.totalTokensUsed.output += usage.outputTokens;
};

type ResolvedSessionOptions = ChatSessionOptions & { maxTurns: number };

@Injectable()
export class ConversationService {
  private readonly conversations = new Map<string, ConversationState>();

  constructor(
    private readonly claudeService: AiService,
    private readonly chatUI: ChatUIService,
    private readonly logger: LoggerService,
    private readonly stageAgentService: StageAgentService
  ) {}

  async createConversation(ticketKey: string, context: ConversationContext): Promise<ConversationState> {
    const conversationId = randomUUID();
    const state = buildInitialState(conversationId, ticketKey, context);
    this.conversations.set(conversationId, state);
    this.logger.debug(`Created conversation: ${conversationId} for ticket: ${ticketKey}`);
    return state;
  }

  async loadConversation(
    ticketKey: string, repoDir?: string, trackerName?: string, artifactDir?: string
  ): Promise<ConversationState | null> {
    const filePath = this.getConversationFilePath(ticketKey, { artifactDir, repoDir, trackerName });
    if (!fs.existsSync(filePath)) return null;
    this.logger.debug(`Loading conversation for ticket: ${ticketKey}`);
    try {
      const state = await this.readConversationState(filePath, artifactDir);
      this.logger.debug(`Loaded conversation: ${state.conversationId} for ticket: ${ticketKey}`);
      return state;
    } catch (error) {
      this.logger.error(`Failed to load conversation for ticket ${ticketKey}: ${error.message}`);
      return null;
    }
  }

  private async readConversationState(filePath: string, artifactDir?: string): Promise<ConversationState> {
    const state = parseConversationFile(await fs.promises.readFile(filePath, 'utf-8'));
    state.context.artifactDir ??= artifactDir;
    this.conversations.set(state.conversationId, state);
    return state;
  }

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

  async getAssistantResponse(
    conversationId: string,
    systemPrompt: string | undefined,
    stage: WorkflowStage
  ): Promise<ConversationMessage> {
    const state = this.conversations.get(conversationId);
    if (!state) throw new StateError(`Conversation not found: ${conversationId}`, { conversationId });
    const messages = buildApiMessages(state);
    this.logger.debug(`Getting assistant response for conversation: ${conversationId} with ${messages.length} messages`);
    const response = await this.claudeService.executeWithHistory({ messages, systemPrompt, stage: stage as AIConversationRequest['stage'] });
    const content = requireAiResponseContent(response, 'AI provider returned an empty chat response');
    return this.recordAssistantMessage(state, content, response.usage);
  }

  async saveConversation(state: ConversationState): Promise<void> {
    try {
      const filePath = this.getConversationFilePath(state.ticketKey, state.context);
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

  private async processAgentTurn(
    input: string, state: ConversationState, stage: AgentStageName,
    systemPrompt: string, repoDir: string, agentSession: AgentChatSession | undefined
  ): Promise<AgentChatSession | undefined> {
    const result = await this.stageAgentService.chatTurn({
      stage, userMessage: input, systemPrompt, repoDir, session: agentSession,
      allowEdits: true, artifactDir: state.context.artifactDir,
    });
    const msg = this.recordAssistantMessage(state, result.content, undefined);
    this.chatUI.displayAssistantResponse(msg, state.context.stage);
    return result.session;
  }

  private async processStandardTurn(
    conversationId: string,
    state: ConversationState,
    systemPrompt: string | undefined,
    stage: WorkflowStage
  ): Promise<void> {
    const response = await this.getAssistantResponse(conversationId, systemPrompt, stage);
    this.chatUI.displayAssistantResponse(response, stage);
    if (response.tokenUsage) this.chatUI.displayTokenUsage(response.tokenUsage, state.totalTokensUsed);
  }

  private resolveAgentBackend(stage: WorkflowStage | undefined): boolean {
    if (stage !== 'plan' && stage !== 'review') return false;
    try {
      return this.stageAgentService.isEnabledForStage(stage as AgentStageName);
    } catch {
      return false;
    }
  }

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
    await this.processStandardTurn(conversationId, state, options.systemPrompt, options.stage ?? state.context.stage);
    return agentSession;
  }

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
    const filePath = this.getConversationFilePath(state.ticketKey, state.context);
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

  getConversation(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId);
  }

  private getConversationFilePath(
    ticketKey: string,
    ctx: { artifactDir?: string; repoDir?: string; trackerName?: string }
  ): string {
    const fileName = `${ticketKey}-conversation.json`;
    if (ctx.artifactDir) return path.join(ctx.artifactDir, fileName);
    const projectDir = path.join(getWfHomeDir(), path.basename(path.resolve(ctx.repoDir ?? process.cwd())));
    return path.join(projectDir, ctx.trackerName ?? '', fileName);
  }
}
