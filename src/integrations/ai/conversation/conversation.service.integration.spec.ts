import { Test, TestingModule } from '@nestjs/testing';
import { ConversationService } from './conversation.service';
import { AiService } from '../ai.service';
import { ChatUIService } from './chat-ui.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ConversationContext } from './interfaces';
import { StageAgentService } from '../stage-agent.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('ConversationService Integration Tests', () => {
  let service: ConversationService;
  let claudeService: jest.Mocked<AiService>;
  let chatUIService: jest.Mocked<ChatUIService>;
  let loggerService: jest.Mocked<LoggerService>;
  let originalHome: string | undefined;
  const testTicketKey = 'TEST-INTEGRATION-999';
  const testHomeDir = path.join(os.tmpdir(), 'wf-conv-integration-home');
  const testRepoDir = path.join(os.tmpdir(), 'wf-conv-integration-test-repo');
  const testDir = path.join(testHomeDir, '.wf', path.basename(testRepoDir));
  const testFilePath = path.join(testDir, `${testTicketKey}-conversation.json`);

  /**
   * Redirect conversation persistence into the writable temp fixture path.
   *
   * @param targetService - Service instance under test
   * @returns Nothing
   */
  const mockConversationPath = (targetService: ConversationService): void => {
    Object.defineProperty(targetService, 'getConversationFilePath', {
      configurable: true,
      value: () => testFilePath,
    });
  };

  beforeEach(async () => {
    originalHome = process.env.HOME;
    process.env.HOME = testHomeDir;

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
        {
          provide: StageAgentService,
          useValue: { isEnabledForStage: () => false, chatTurn: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    mockConversationPath(service);

    // Ensure test directory exists
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Clean up any existing test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('File Persistence', () => {
    it('should save conversation to disk', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const conversation = await service.createConversation(testTicketKey, context);
      await service.addUserMessage(conversation.conversationId, 'Hello');

      await service.saveConversation(conversation);

      expect(fs.existsSync(testFilePath)).toBe(true);

      const fileContent = fs.readFileSync(testFilePath, 'utf-8');
      const savedState = JSON.parse(fileContent);

      expect(savedState.conversationId).toBe(conversation.conversationId);
      expect(savedState.ticketKey).toBe(testTicketKey);
      expect(savedState.messages.length).toBe(1);
      expect(savedState.messages[0].content).toBe('Hello');
    });

    it('should load conversation from disk', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      // Create and save a conversation
      const original = await service.createConversation(testTicketKey, context);
      await service.addUserMessage(original.conversationId, 'Test message');
      await service.saveConversation(original);

      // Create a new service instance to test loading
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationService,
          { provide: AiService, useValue: claudeService },
          { provide: ChatUIService, useValue: chatUIService },
          { provide: LoggerService, useValue: loggerService },
          {
            provide: StageAgentService,
            useValue: { isEnabledForStage: () => false, chatTurn: jest.fn() },
          },
        ],
      }).compile();

      const newService = module.get<ConversationService>(ConversationService);
      mockConversationPath(newService);
      const loaded = await newService.loadConversation(testTicketKey, testRepoDir);

      expect(loaded).toBeDefined();
      expect(loaded?.conversationId).toBe(original.conversationId);
      expect(loaded?.messages.length).toBe(1);
      expect(loaded?.messages[0].content).toBe('Test message');
      expect(loaded?.createdAt).toBeInstanceOf(Date);
      expect(loaded?.updatedAt).toBeInstanceOf(Date);
    });

    it('should return null when loading non-existent conversation', async () => {
      const loaded = await service.loadConversation('NON-EXISTENT-123');
      expect(loaded).toBeNull();
    });

    it('should handle corrupted conversation file gracefully', async () => {
      // Write invalid JSON to file
      fs.writeFileSync(testFilePath, 'invalid json content');

      const loaded = await service.loadConversation(testTicketKey, testRepoDir);

      expect(loaded).toBeNull();
      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load conversation'));
    });

    it('should use atomic write operation (temp file + rename)', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const conversation = await service.createConversation(testTicketKey, context);

      // Monitor file system operations
      const writeFileSpy = jest.spyOn(fs.promises, 'writeFile');
      const renameSpy = jest.spyOn(fs.promises, 'rename');

      await service.saveConversation(conversation);

      expect(writeFileSpy).toHaveBeenCalledWith(expect.stringContaining('.tmp'), expect.any(String), 'utf-8');
      expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining('.tmp'), testFilePath);

      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  describe('Resume Capability', () => {
    it('should resume conversation across service instances', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      // First session: create and add messages
      const conv1 = await service.createConversation(testTicketKey, context);
      await service.addUserMessage(conv1.conversationId, 'First message');
      await service.saveConversation(conv1);

      // Second session: load and continue
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationService,
          { provide: AiService, useValue: claudeService },
          { provide: ChatUIService, useValue: chatUIService },
          { provide: LoggerService, useValue: loggerService },
          {
            provide: StageAgentService,
            useValue: { isEnabledForStage: () => false, chatTurn: jest.fn() },
          },
        ],
      }).compile();

      const service2 = module2.get<ConversationService>(ConversationService);
      mockConversationPath(service2);
      const conv2 = await service2.loadConversation(testTicketKey, testRepoDir);

      if (!conv2) throw new Error('expected conv2');
      await service2.addUserMessage(conv2.conversationId, 'Second message');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      await service2.getAssistantResponse(conv2.conversationId);
      await service2.saveConversation(conv2);

      // Third session: verify full history
      const module3: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationService,
          { provide: AiService, useValue: claudeService },
          { provide: ChatUIService, useValue: chatUIService },
          { provide: LoggerService, useValue: loggerService },
          {
            provide: StageAgentService,
            useValue: { isEnabledForStage: () => false, chatTurn: jest.fn() },
          },
        ],
      }).compile();

      const service3 = module3.get<ConversationService>(ConversationService);
      mockConversationPath(service3);
      const conv3 = await service3.loadConversation(testTicketKey, testRepoDir);

      expect(conv3?.messages.length).toBe(3);
      expect(conv3?.messages[0].content).toBe('First message');
      expect(conv3?.messages[1].content).toBe('Second message');
      expect(conv3?.messages[2].role).toBe('assistant');
      expect(conv3?.totalTokensUsed).toEqual({ input: 100, output: 50 });
    });

    it('should preserve token usage across resume', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const conv1 = await service.createConversation(testTicketKey, context);
      await service.addUserMessage(conv1.conversationId, 'Hello');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response 1',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      await service.getAssistantResponse(conv1.conversationId);
      await service.saveConversation(conv1);

      // Load in new session
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationService,
          { provide: AiService, useValue: claudeService },
          { provide: ChatUIService, useValue: chatUIService },
          { provide: LoggerService, useValue: loggerService },
          {
            provide: StageAgentService,
            useValue: { isEnabledForStage: () => false, chatTurn: jest.fn() },
          },
        ],
      }).compile();

      const service2 = module2.get<ConversationService>(ConversationService);
      mockConversationPath(service2);
      const conv2 = await service2.loadConversation(testTicketKey, testRepoDir);

      expect(conv2?.totalTokensUsed).toEqual({ input: 100, output: 50 });

      if (!conv2) throw new Error('expected conv2');
      await service2.addUserMessage(conv2.conversationId, 'Another message');

      claudeService.executeWithHistory.mockResolvedValue({
        content: 'Response 2',
        usage: { inputTokens: 120, outputTokens: 60 },
      });

      await service2.getAssistantResponse(conv2.conversationId);

      expect(conv2.totalTokensUsed).toEqual({ input: 220, output: 110 });
    });
  });

  describe('Error Handling', () => {
    it('should handle missing directory when saving', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const conversation = await service.createConversation(testTicketKey, context);

      // Remove directory
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true });
      }

      // Save should create directory and succeed
      await expect(service.saveConversation(conversation)).resolves.not.toThrow();

      expect(fs.existsSync(testFilePath)).toBe(true);
    });

    it('should throw error when saving fails', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const conversation = await service.createConversation(testTicketKey, context);

      // Mock writeFile to fail
      const writeFileSpy = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('Disk full'));

      await expect(service.saveConversation(conversation)).rejects.toThrow('Disk full');

      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to save conversation'));

      writeFileSpy.mockRestore();
    });
  });

  describe('Date Serialization', () => {
    it('should correctly serialize and deserialize dates', async () => {
      const context: ConversationContext = {
        ticketKey: testTicketKey,
        stage: 'plan',
        repoDir: testRepoDir,
        workflowState: { ticketContent: 'Test ticket' },
      };

      const original = await service.createConversation(testTicketKey, context);
      const createdTime = original.createdAt.getTime();

      await service.addUserMessage(original.conversationId, 'Test');
      const messageTime = original.messages[0].timestamp.getTime();

      await service.saveConversation(original);

      // Load and verify dates
      const loaded = await service.loadConversation(testTicketKey, testRepoDir);

      expect(loaded?.createdAt).toBeInstanceOf(Date);
      expect(loaded?.updatedAt).toBeInstanceOf(Date);
      expect(loaded?.messages[0].timestamp).toBeInstanceOf(Date);

      expect(loaded?.createdAt.getTime()).toBe(createdTime);
      expect(loaded?.messages[0].timestamp.getTime()).toBe(messageTime);
    });
  });
});
