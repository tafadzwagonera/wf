import { Test, TestingModule } from '@nestjs/testing';
import { ChatUIService } from './chat-ui.service';
import { ConversationMessage } from './interfaces';
import { AiService, REVIEW_VERDICT_APPROVED } from '../ai.service';

// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;

  // Create chainable color methods
  const createChain = () => {
    const chain: any = identity;
    chain.bold = identity;
    chain.dim = identity;
    chain.italic = identity;
    chain.underline = identity;
    chain.inverse = identity;
    chain.strikethrough = identity;
    chain.black = identity;
    chain.red = identity;
    chain.green = identity;
    chain.yellow = identity;
    chain.blue = identity;
    chain.magenta = identity;
    chain.cyan = identity;
    chain.white = identity;
    chain.gray = identity;
    chain.grey = identity;
    return chain;
  };

  const chalk = createChain();
  chalk.bold = createChain();
  chalk.bold.cyan = identity;
  chalk.bold.magenta = identity;

  return {
    default: chalk,
    ...chalk,
  };
});

describe('ChatUIService', () => {
  let service: ChatUIService;
  let consoleLogSpy: jest.SpyInstance;
  const mockAiService = {
    getProviderShortName: jest.fn(() => 'Claude'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatUIService,
        {
          provide: AiService,
          useValue: mockAiService,
        },
      ],
    }).compile();

    service = module.get<ChatUIService>(ChatUIService);

    // Spy on console.log
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    jest.clearAllMocks();
  });

  describe('displayChatIntro', () => {
    it('should display chat introduction', () => {
      const context = {
        ticketKey: 'TEST-123',
        stage: 'plan' as const,
        workflowState: { ticketContent: 'Test' },
      };

      service.displayChatIntro('plan', context);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Interactive Chat Mode'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Current Stage: PLAN'));
    });

    it('should display plan context when available', () => {
      const context = {
        ticketKey: 'TEST-123',
        stage: 'plan' as const,
        stageOutput: {
          summary: 'Fix authentication bug',
          estimatedComplexity: 'medium',
        },
        workflowState: { ticketContent: 'Test' },
      };

      service.displayChatIntro('plan', context);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Plan Summary: Fix authentication bug'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Complexity: MEDIUM'));
    });

    it('should display review context when available', () => {
      const context = {
        ticketKey: 'TEST-123',
        stage: 'review' as const,
        stageOutput: {
          summary: 'Code looks good',
          approved: true,
        },
        workflowState: { ticketContent: 'Test' },
      };

      service.displayChatIntro('review', context);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review Summary: Code looks good'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(REVIEW_VERDICT_APPROVED));
    });
  });

  describe('promptUserInput', () => {
    it('should return exit flag for exit commands', async () => {
      // Mock inquirer to return exit command
      const mockInquirer = jest.fn().mockResolvedValue({ message: 'exit' });
      (service as any).inquirer = mockInquirer;

      const result = await service.promptUserInput(1, 20);

      expect(result.input).toBe('exit');
      expect(result.shouldExit).toBe(true);
    });

    it('should recognize all exit commands', async () => {
      const exitCommands = ['exit', 'quit', 'continue', 'EXIT', 'Quit'];
      const mockInquirer = jest.fn();
      (service as any).inquirer = mockInquirer;

      for (const cmd of exitCommands) {
        mockInquirer.mockResolvedValueOnce({ message: cmd });
        const result = await service.promptUserInput(1, 20);
        expect(result.shouldExit).toBe(true);
      }
    });

    it('should not flag regular messages as exit', async () => {
      const mockInquirer = jest.fn().mockResolvedValue({ message: 'Can you explain this?' });
      (service as any).inquirer = mockInquirer;

      const result = await service.promptUserInput(1, 20);

      expect(result.input).toBe('Can you explain this?');
      expect(result.shouldExit).toBe(false);
    });

    it('should display remaining turns in prompt message', async () => {
      const mockInquirer = jest.fn().mockResolvedValue({ message: 'hello' });
      (service as any).inquirer = mockInquirer;

      await service.promptUserInput(2, 20);

      expect(mockInquirer).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('18 turns left (2/20)'),
        })
      );
    });

    it('should trim whitespace from input', async () => {
      const mockInquirer = jest.fn().mockResolvedValue({ message: '  test message  ' });
      (service as any).inquirer = mockInquirer;

      const result = await service.promptUserInput(1, 20);

      expect(result.input).toBe('test message');
    });
  });

  describe('displayAssistantResponse', () => {
    it('should display assistant message', () => {
      const message: ConversationMessage = {
        role: 'assistant',
        content: 'This is a response from Claude',
        timestamp: new Date(),
      };

      service.displayAssistantResponse(message);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude:'));
      expect(consoleLogSpy).toHaveBeenCalledWith('This is a response from Claude');
    });

    it('should handle multiline content', () => {
      const message: ConversationMessage = {
        role: 'assistant',
        content: 'Line 1\nLine 2\nLine 3',
        timestamp: new Date(),
      };

      service.displayAssistantResponse(message);

      expect(consoleLogSpy).toHaveBeenCalledWith('Line 1');
      expect(consoleLogSpy).toHaveBeenCalledWith('Line 2');
      expect(consoleLogSpy).toHaveBeenCalledWith('Line 3');
    });
  });

  describe('displayTokenUsage', () => {
    it('should display token statistics', () => {
      const currentUsage = { inputTokens: 100, outputTokens: 50 };
      const totalUsage = { input: 500, output: 250 };

      service.displayTokenUsage(currentUsage, totalUsage);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tokens: Input: 100 | Output: 50 | Total: 150')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Conversation Total: 750 (500 in, 250 out)'));
    });
  });

  describe('displayConversationHistory', () => {
    it('should display empty history message', () => {
      service.displayConversationHistory([]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Conversation History'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No messages yet'));
    });

    it('should display message history', () => {
      const messages: ConversationMessage[] = [
        {
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-03-18T10:00:00Z'),
        },
        {
          role: 'assistant',
          content: 'Hi there!',
          timestamp: new Date('2026-03-18T10:00:15Z'),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        },
      ];

      service.displayConversationHistory(messages);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('You [1]:'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude [2]:'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Hello'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Hi there!'));
    });

    it('should truncate long messages in history', () => {
      const longContent = 'a'.repeat(200);
      const messages: ConversationMessage[] = [
        {
          role: 'user',
          content: longContent,
          timestamp: new Date(),
        },
      ];

      service.displayConversationHistory(messages);

      // Should display truncated version (150 chars + ...)
      const truncatedCalls = consoleLogSpy.mock.calls.filter(
        call => call[0] && typeof call[0] === 'string' && call[0].includes('...')
      );
      expect(truncatedCalls.length).toBeGreaterThan(0);
    });
  });

  describe('displayHelp', () => {
    it('should display help information', () => {
      service.displayHelp();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Chat Commands'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('history'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('help'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('exit'));
    });
  });

  describe('displayChatEnd', () => {
    it('should display end message with file path', () => {
      const filePath = '/path/to/conversation.json';

      service.displayChatEnd(filePath);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Chat session saved'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(filePath));
    });
  });

  describe('displayError', () => {
    it('should display error message', () => {
      service.displayError('Something went wrong');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Error: Something went wrong'));
    });
  });

  describe('displayWarning', () => {
    it('should display warning message', () => {
      service.displayWarning('This is a warning');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: This is a warning'));
    });
  });

  describe('displayMaxTurnsReached', () => {
    it('should display max turns message', () => {
      service.displayMaxTurnsReached(20);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Maximum conversation turns (20) reached'));
    });
  });
});
