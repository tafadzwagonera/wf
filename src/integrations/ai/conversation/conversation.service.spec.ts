import { Test, TestingModule } from '@nestjs/testing';
import { ConversationService } from './conversation.service';
import { AiService } from '../ai.service';
import { ChatUIService } from './chat-ui.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ConversationContext } from './interfaces';
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: AiService, useValue: claudeService },
        { provide: ChatUIService, useValue: chatUIService },
        { provide: LoggerService, useValue: loggerService },
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

      expect(loggerService.debug).toHaveBeenCalledWith(
        expect.stringContaining('Created conversation'),
      );
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

      const updated = await service.addUserMessage(
        conversation.conversationId,
        userMessage,
      );

      expect(updated.messages.length).toBe(1);
      expect(updated.messages[0].role).toBe('user');
      expect(updated.messages[0].content).toBe(userMessage);
      expect(updated.messages[0].timestamp).toBeInstanceOf(Date);
    });

    it('should throw error if conversation not found', async () => {
      await expect(
        service.addUserMessage('invalid-id', 'test'),
      ).rejects.toThrow('Conversation not found');
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

      const response = await service.getAssistantResponse(
        conversation.conversationId,
        'You are helpful',
      );

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
      await expect(service.getAssistantResponse('invalid-id')).rejects.toThrow(
        'Conversation not found',
      );
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

      const expectedPath = path.join(
        os.homedir(),
        '.wf',
        'my-app',
        'review-conversation.json',
      );
      expect(fs.promises.rename).toHaveBeenCalledWith(
        `${expectedPath}.tmp`,
        expectedPath,
      );
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

      const expectedPath = path.join(
        os.homedir(),
        '.wf',
        'my-app',
        'jira',
        'TAD-575-conversation.json',
      );
      expect(fs.promises.rename).toHaveBeenCalledWith(
        `${expectedPath}.tmp`,
        expectedPath,
      );
    });
  });
});
