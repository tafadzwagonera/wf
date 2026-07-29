import { Test, TestingModule } from '@nestjs/testing';
import { ConversationService } from './conversation.service';
import { AiService } from '../ai.service';
import { ChatUIService } from './chat-ui.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ConversationContext } from './interfaces';
import { StageAgentService } from '../stage-agent.service';
import { AIError } from '../../../shared/utils/errors';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      mkdir: jest.fn().mockResolvedValue(undefined),
    },
  };
});

describe('ConversationService', () => {
  let service: ConversationService;
  let claudeService: jest.Mocked<AiService>;
  let chatUIService: jest.Mocked<ChatUIService>;
  let loggerService: jest.Mocked<LoggerService>;
  let stageAgentService: jest.Mocked<StageAgentService>;

  beforeEach(async () => {
    // Create mocks
    claudeService = {
      executeWithHistory: jest.fn(),
    } as any;

    chatUIService = {
      displayChatIntro: jest.fn(),
      promptUserInput: jest.fn(),
      displayAssistantResponse: jest.fn(),
      displayTokenUsage: jest.fn(),
      displayConversationHistory: jest.fn(),
      displayHelp: jest.fn(),
      displayChatEnd: jest.fn(),
      displayError: jest.fn(),
      displayMaxTurnsReached: jest.fn(),
    } as any;

    loggerService = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    } as any;

    stageAgentService = {
      isEnabledForStage: jest.fn().mockReturnValue(false),
      chatTurn: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: AiService, useValue: claudeService },
        { provide: ChatUIService, useValue: chatUIService },
        { provide: LoggerService, useValue: loggerService },
        { provide: StageAgentService, useValue: stageAgentService },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createConversation', () => {
    it('should create a new conversation with unique ID', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: {
          ticketContent: 'Test ticket content',
        },
      };

      const conversation = await service.createConversation(ticketKey, context);

      expect(conversation).toBeDefined();
      expect(conversation.conversationId).toBeDefined();
      expect(conversation.ticketKey).toBe(ticketKey);
      expect(conversation.messages).toEqual([]);
      expect(conversation.context).toEqual(context);
      expect(conversation.totalTokensUsed).toEqual({ input: 0, output: 0 });
      expect(conversation.createdAt).toBeInstanceOf(Date);
      expect(conversation.updatedAt).toBeInstanceOf(Date);
    });

    it('should log conversation creation', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: { ticketContent: 'Test' },
      };

      await service.createConversation(ticketKey, context);

      expect(loggerService.debug).toHaveBeenCalledWith(expect.stringContaining('Created conversation'));
    });
  });

  describe('addUserMessage', () => {
    it('should add user message to conversation', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation(ticketKey, context);
      const userMessage = 'Can you explain this?';

      const updated = await service.addUserMessage(conversation.conversationId, userMessage);

      expect(updated.messages.length).toBe(1);
      expect(updated.messages[0].role).toBe('user');
      expect(updated.messages[0].content).toBe(userMessage);
      expect(updated.messages[0].timestamp).toBeInstanceOf(Date);
    });

    it('should throw error if conversation not found', async () => {
      await expect(service.addUserMessage('invalid-id', 'test')).rejects.toThrow('Conversation not found');
    });
  });

  describe('getAssistantResponse', () => {
    it('should call Claude with full conversation history', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation(ticketKey, context);
      await service.addUserMessage(conversation.conversationId, 'Hello');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Hi there!',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      });

      const response = await service.getAssistantResponse(conversation.conversationId, 'You are helpful');

      expect(claudeService.executeWithHistory).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'You are helpful',
      });

      expect(response.role).toBe('assistant');
      expect(response.content).toBe('Hi there!');
      expect(response.tokenUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it('should accumulate token usage', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation(ticketKey, context);
      await service.addUserMessage(conversation.conversationId, 'Hello');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      await service.getAssistantResponse(conversation.conversationId);

      const state = service.getConversation(conversation.conversationId);
      expect(state?.totalTokensUsed).toEqual({ input: 100, output: 50 });
    });

    it('should throw error if conversation not found', async () => {
      await expect(service.getAssistantResponse('invalid-id')).rejects.toThrow('Conversation not found');
    });

    it('raises an AIError when the standard assistant response is blank', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'review',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation(ticketKey, context);
      await service.addUserMessage(conversation.conversationId, 'Hello');

      claudeService.executeWithHistory.mockResolvedValue({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
      } as any);

      await expect(service.getAssistantResponse(conversation.conversationId)).rejects.toMatchObject({
        message: 'AI provider returned an empty chat response',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      } satisfies Partial<AIError>);
    });
  });

  describe('getConversation', () => {
    it('should retrieve conversation from memory', async () => {
      const ticketKey = 'TEST-123';
      const context: ConversationContext = {
        ticketKey,
        stage: 'plan',
        workflowState: { ticketContent: 'Test' },
      };

      const created = await service.createConversation(ticketKey, context);
      const retrieved = service.getConversation(created.conversationId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.conversationId).toBe(created.conversationId);
    });

    it('should return undefined for non-existent conversation', () => {
      const retrieved = service.getConversation('invalid-id');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAssistantResponse with stage', () => {
    it('should forward stage to executeWithHistory', async () => {
      const context: ConversationContext = {
        ticketKey: 'TEST-123',
        stage: 'review',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation('TEST-123', context);
      await service.addUserMessage(conversation.conversationId, 'Hello');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      await service.getAssistantResponse(conversation.conversationId, 'system', 'review');

      expect(claudeService.executeWithHistory).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review' }));
    });
  });

  describe('startChatSession dispatch', () => {
    it('should use standard path when stage agent is disabled', async () => {
      const context: ConversationContext = {
        ticketKey: 'TEST-123',
        stage: 'review',
        repoDir: '/projects/repo',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation('TEST-123', context);

      stageAgentService.isEnabledForStage.mockReturnValue(false);
      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Standard response',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      chatUIService.promptUserInput
        .mockResolvedValueOnce({ input: 'question', shouldExit: false })
        .mockResolvedValueOnce({ input: '', shouldExit: true });

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.startChatSession(conversation.conversationId, {
        systemPrompt: 'system',
        stage: 'review',
        repoDir: '/projects/repo',
      });

      expect(claudeService.executeWithHistory).toHaveBeenCalledTimes(1);
      expect(stageAgentService.chatTurn).not.toHaveBeenCalled();
    });

    it('should use agent path when stage agent is enabled', async () => {
      const context: ConversationContext = {
        ticketKey: 'TEST-123',
        stage: 'review',
        repoDir: '/projects/repo',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation('TEST-123', context);

      stageAgentService.isEnabledForStage.mockReturnValue(true);
      stageAgentService.chatTurn.mockResolvedValue({
        content: 'Agent response',
        session: { provider: 'anthropic', sessionId: 'sess-1' },
      });

      chatUIService.promptUserInput
        .mockResolvedValueOnce({ input: 'question', shouldExit: false })
        .mockResolvedValueOnce({ input: '', shouldExit: true });

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.startChatSession(conversation.conversationId, {
        systemPrompt: 'system',
        stage: 'review',
        repoDir: '/projects/repo',
      });

      expect(stageAgentService.chatTurn).toHaveBeenCalledTimes(1);
      expect(stageAgentService.chatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'review',
          userMessage: 'question',
          systemPrompt: 'system',
          repoDir: '/projects/repo',
        })
      );
      expect(claudeService.executeWithHistory).not.toHaveBeenCalled();
      expect(chatUIService.displayAssistantResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: 'Agent response',
        })
      );
    });

    it('should seed agent chat session with resumeProviderSessionId on first turn', async () => {
      const context: ConversationContext = {
        ticketKey: 'TEST-123',
        stage: 'review',
        repoDir: '/projects/repo',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation('TEST-123', context);

      stageAgentService.isEnabledForStage.mockReturnValue(true);
      stageAgentService.chatTurn.mockResolvedValue({
        content: 'Resumed response',
        session: { provider: 'anthropic', sessionId: 'sess-resumed' },
      });

      chatUIService.promptUserInput
        .mockResolvedValueOnce({ input: 'follow-up question', shouldExit: false })
        .mockResolvedValueOnce({ input: '', shouldExit: true });

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.startChatSession(conversation.conversationId, {
        systemPrompt: 'system',
        stage: 'review',
        repoDir: '/projects/repo',
        resumeProviderSessionId: 'sess-from-review',
      });

      expect(stageAgentService.chatTurn).toHaveBeenCalledTimes(1);
      expect(stageAgentService.chatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ sessionId: 'sess-from-review' }),
        })
      );
    });

    it('should fall back to standard path when no stage is provided', async () => {
      const context: ConversationContext = {
        ticketKey: 'TEST-123',
        stage: 'review',
        workflowState: { ticketContent: 'Test' },
      };

      const conversation = await service.createConversation('TEST-123', context);

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      chatUIService.promptUserInput
        .mockResolvedValueOnce({ input: 'hi', shouldExit: false })
        .mockResolvedValueOnce({ input: '', shouldExit: true });

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.startChatSession(conversation.conversationId, {
        systemPrompt: 'system',
      });

      expect(stageAgentService.isEnabledForStage).not.toHaveBeenCalled();
      expect(claudeService.executeWithHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConversationFilePath (via saveConversation)', () => {
    it('resolves to ~/.wf/<repo>/ when repoDir is present but trackerName is absent', async () => {
      const context: ConversationContext = {
        ticketKey: 'review',
        stage: 'review',
        repoDir: '/projects/my-app',
        workflowState: { ticketContent: 'test' },
      };

      const conversation = await service.createConversation('review', context);

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.saveConversation(conversation);

      const expectedPath = path.join(os.homedir(), '.wf', 'my-app', 'review-conversation.json');
      expect(fs.promises.rename).toHaveBeenCalledWith(`${expectedPath}.tmp`, expectedPath);
    });

    it('resolves to ~/.wf/<repo>/<tracker>/ when both repoDir and trackerName are present', async () => {
      const context: ConversationContext = {
        ticketKey: 'TAD-575',
        stage: 'review',
        repoDir: '/projects/my-app',
        trackerName: 'jira',
        workflowState: { ticketContent: 'test' },
      };

      const conversation = await service.createConversation('TAD-575', context);

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.saveConversation(conversation);

      const expectedPath = path.join(os.homedir(), '.wf', 'my-app', 'jira', 'TAD-575-conversation.json');
      expect(fs.promises.rename).toHaveBeenCalledWith(`${expectedPath}.tmp`, expectedPath);
    });

    it('resolves to ~/.wf/<cwd-basename>/ when repoDir is absent', async () => {
      const context: ConversationContext = {
        ticketKey: 'WBP-100',
        stage: 'plan',
        workflowState: { ticketContent: 'test' },
      };

      const conversation = await service.createConversation('WBP-100', context);

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await service.saveConversation(conversation);

      const cwdBaseName = path.basename(path.resolve(process.cwd()));
      const expectedPath = path.join(os.homedir(), '.wf', cwdBaseName, 'WBP-100-conversation.json');
      expect(fs.promises.rename).toHaveBeenCalledWith(`${expectedPath}.tmp`, expectedPath);
    });
  });
});
