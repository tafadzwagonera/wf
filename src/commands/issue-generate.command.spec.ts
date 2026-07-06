// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold',
      'dim',
      'italic',
      'underline',
      'inverse',
      'strikethrough',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
    ].forEach(name => {
      chain[name] = identity;
    });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readdirSync: jest.fn(actual.readdirSync),
    writeFileSync: jest.fn(actual.writeFileSync),
    promises: {
      ...actual.promises,
      mkdir: jest.fn(actual.promises.mkdir),
      writeFile: jest.fn(actual.promises.writeFile),
    },
  };
});

jest.mock('../shared/utils/ensure-wf-home', () => ({
  ensureWfHome: jest.fn(),
}));

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app'
    ),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueGenerateCommand } from './issue-generate.command';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { AiService } from '../integrations/ai/ai.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { SlackService } from '../integrations/slack/slack.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { hashGeneratedTicketSources } from '../shared/utils/generated-ticket-artifact';
import inquirer from 'inquirer';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(options?: { generateAgentEnabled?: boolean }): Promise<{
  command: IssueGenerateCommand;
  mockAiService: Record<string, jest.Mock>;
  mockStageAgentService: Record<string, jest.Mock>;
}> {
  const mockSlackService = {
    fetchThread: jest.fn(),
    fetchChannelHistory: jest.fn(),
  };
  const mockAiService = {
    getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
    execute: jest.fn().mockResolvedValue({
      content: [
        '# Generated Title',
        '',
        '**Type:** task',
        '**Priority:** medium',
        '',
        '## Description',
        '',
        '### Summary',
        'Generated summary',
        '',
        '#### Technical Details',
        'None',
        '',
        '### Acceptance Criteria',
        '- None',
        '',
        '### Risks & Assumptions',
        '- None',
        '',
        '#### Out of Scope',
        '- None',
      ].join('\n'),
    }),
  };
  const mockStageAgentService = {
    isEnabledForStage: jest.fn((stage: string) =>
      stage === 'generate' ? options?.generateAgentEnabled === true : false
    ),
    generateFromPrompt: jest
      .fn()
      .mockResolvedValue(
        [
          '# Agent Generated Title',
          '',
          '**Type:** task',
          '**Priority:** medium',
          '',
          '## Description',
          '',
          '### Summary',
          'Agent generated summary',
          '',
          '#### Technical Details',
          'None',
          '',
          '### Acceptance Criteria',
          '- None',
          '',
          '### Risks & Assumptions',
          '- None',
          '',
          '#### Out of Scope',
          '- None',
        ].join('\n')
      ),
  };
  const module = await Test.createTestingModule({
    providers: [
      IssueGenerateCommand,
      { provide: IssueTrackerService, useValue: {} },
      {
        provide: FormatConverterService,
        useValue: {
          detectFormat: jest.fn((filePath: string) => path.extname(filePath).slice(1)),
          getConverter: jest.fn(() => ({
            serialize: jest.fn(ticket =>
              [`# ${ticket.title ?? 'Generated Title'}`, '', ticket.description ?? 'Generated summary'].join('\n')
            ),
            parse: jest.fn(() => ({
              title: 'Generated Title',
              description: 'Generated summary',
              type: 'task',
              priority: 'medium',
            })),
          })),
        },
      },
      {
        provide: AiService,
        useValue: mockAiService,
      },
      {
        provide: StageAgentService,
        useValue: mockStageAgentService,
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'tracker') return 'jira';
            return defaultValue;
          }),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          success: jest.fn(),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
      { provide: SlackService, useValue: mockSlackService },
    ],
  }).compile();

  return {
    command: module.get(IssueGenerateCommand),
    mockAiService,
    mockStageAgentService,
  };
}

describe('IssueGenerateCommand', () => {
  let cwdSpy: jest.SpyInstance;
  let mkdirSpy: jest.SpyInstance;
  let writeFileSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    mkdirSpy = jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    writeFileSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReset();
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReset();
    (fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>).mockReset();
    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(
      jest.requireActual('fs').existsSync
    );
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockImplementation(() => []);
    (fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>).mockImplementation(
      jest.requireActual('fs').writeFileSync
    );
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeFileSpy.mockRestore();
    consoleLogSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    jest.restoreAllMocks();
  });

  describe('parseFormat', () => {
    it('accepts json|md|yaml|yml', async () => {
      const { command } = await buildCommand();

      expect(command.parseFormat('json')).toBe('json');
      expect(command.parseFormat('md')).toBe('md');
      expect(command.parseFormat('yaml')).toBe('yaml');
      expect(command.parseFormat('yml')).toBe('yml');
    });

    it('rejects xml', async () => {
      const { command } = await buildCommand();

      expect(() => command.parseFormat('xml')).toThrow('Invalid format');
    });
  });

  describe('AI stage routing', () => {
    it('uses the generate stage override when synthesizing ticket content', async () => {
      const { command } = await buildCommand();
      const aiService = (command as any).aiService as jest.Mocked<AiService>;

      await (command as any).synthesizeWithAI([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
      ]);

      expect(aiService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'generate',
          maxTokens: 4096,
        })
      );
    });

    it('uses the stage agent service when generate agent mode is enabled', async () => {
      const { command, mockAiService, mockStageAgentService } = await buildCommand({
        generateAgentEnabled: true,
      });

      await (command as any).synthesizeWithAI([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
        {
          type: 'file',
          source: './more-notes.md',
          content: 'Another source to avoid the single-source bypass',
        },
      ]);

      expect(mockStageAgentService.generateFromPrompt).toHaveBeenCalledTimes(1);
      expect(mockAiService.execute).not.toHaveBeenCalled();
    });

    it('synthesizes and parses a generated ticket for short inputs that require AI collation', async () => {
      const { command, mockAiService, mockStageAgentService } = await buildCommand();

      const ticket = await (command as any).synthesizeWithAI([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
        {
          type: 'file',
          source: './constraints.md',
          content: 'A second short source keeps the AI synthesis path active',
        },
      ]);

      expect(mockStageAgentService.generateFromPrompt).not.toHaveBeenCalled();
      expect(mockAiService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'generate',
          maxTokens: 4096,
        })
      );
      expect(ticket).toEqual(
        expect.objectContaining({
          title: 'Generated Title',
          description: 'Generated summary',
          type: 'task',
          priority: 'medium',
        })
      );
    });

    it('instructs the model to use fenced code blocks and hyphen bullets only', async () => {
      const { command } = await buildCommand();

      const prompt = (command as any).buildSynthesisPrompt([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
      ]);

      expect(prompt).toContain(
        'Use fenced Markdown code blocks (```lang) for code samples; never use Jira wiki {code} syntax.'
      );
      expect(prompt).toContain('Use `- ` for every unordered bullet item; never use `* ` bullets.');
    });

    it('instructs the model to follow formal writing conventions in the prompt', async () => {
      const { command } = await buildCommand();

      const prompt = (command as any).buildSynthesisPrompt([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
      ]);

      expect(prompt).toContain('Write in formal British English throughout.');
      expect(prompt).toContain(
        'Do not use contractions (e.g., write "do not" instead of "don\'t", "cannot" instead of "can\'t").'
      );
      expect(prompt).toContain(
        'Use the active voice (e.g., "The system validates input" instead of "Input is validated by the system").'
      );
      expect(prompt).toContain(
        'Do not use informal or colloquial language (e.g., avoid "basically", "just", "a lot of", "pretty much").'
      );
      expect(prompt).toContain('Use third-person perspective only (e.g., do not use "you", "we", "our").');
      expect(prompt).toContain(
        'Use British English spelling (e.g., "behaviour", "colour", "organisation", "serialise").'
      );
      expect(prompt).toContain(
        'Be concise: prefer short, direct sentences; remove filler words, redundant qualifiers, and unnecessary preamble.'
      );
    });

    it('includes repo conventions section when context is provided', async () => {
      const { command } = await buildCommand();
      const mockContext = {
        conventions: {
          language: 'typescript',
          linter: { tool: 'eslint', keyRules: { semi: true } },
          typescript: {
            strict: true,
            module: 'commonjs',
            target: 'ES2021',
            paths: {},
          },
          go: null,
          python: null,
          terraform: null,
          folderStructure: ['agents', 'commands'],
          namingPattern: 'kebab-case',
          nestjsDetected: true,
          importStyle: 'commonjs',
          keyDependencies: ['@nestjs/core'],
          errorHandlingPaths: [],
        },
        priorPlans: {
          repoName: 'test-repo',
          plans: [
            {
              title: 'Fix pricing timeout',
              summary: 'Fix pricing timeout',
              filename: '2026-07-01-abc123-fix-plan.json',
              keywords: ['PricingService'],
              steps: ['Inspect PricingService'],
              action: 'fix',
              estimatedComplexity: 'medium',
              ticketKey: 'WBP-123',
            },
          ],
        },
      };

      const prompt = (command as any).buildSynthesisPrompt(
        [{ type: 'file', source: './notes.md', content: 'Test content' }],
        mockContext
      );

      expect(prompt).toContain('Repository conventions (test-repo):');
      expect(prompt).toContain('Language: typescript');
      expect(prompt).toContain('Linter: eslint');
      expect(prompt).toContain('Related prior plans (test-repo):');
    });

    it('omits repo context sections when no context provided', async () => {
      const { command } = await buildCommand();

      const prompt = (command as any).buildSynthesisPrompt([
        { type: 'file', source: './notes.md', content: 'Test content' },
      ]);

      expect(prompt).not.toContain('Repository conventions');
      expect(prompt).not.toContain('Related prior tickets');
      expect(prompt).not.toContain('Related prior plans');
    });
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any)).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('local structured file fallback', () => {
    it('returns a ticket source when a local structured file parses as a ticket', async () => {
      const { command } = await buildCommand();
      const formatConverterService = (command as any).formatConverterService as FormatConverterService;
      const tempSourcePath = path.join(os.tmpdir(), 'wf-ticket-source.md');
      const ticket = {
        title: 'Imported ticket',
        description: 'Ticket body',
        type: 'task',
        priority: 'medium',
      };

      fs.writeFileSync(tempSourcePath, '# Imported ticket', 'utf-8');
      jest.spyOn(formatConverterService, 'detectFormat').mockReturnValueOnce('md');
      jest.spyOn(formatConverterService, 'getConverter').mockReturnValueOnce({
        parse: jest.fn(() => ticket),
        serialize: jest.fn(),
      } as any);

      try {
        await expect((command as any).fetchFromFile(tempSourcePath)).resolves.toEqual(
          expect.objectContaining({
            type: 'ticket',
            source: tempSourcePath,
            content: '# Imported ticket',
            ticket,
          })
        );
      } finally {
        fs.unlinkSync(tempSourcePath);
      }
    });

    it.each(['.md', '.json', '.yaml', '.yml'])(
      'returns a file source when a local %s file is not recognized as ticket-formatted content',
      async extension => {
        const { command } = await buildCommand();
        const formatConverterService = (command as any).formatConverterService as FormatConverterService;
        const tempSourcePath = path.join(os.tmpdir(), `wf-non-ticket-source${extension}`);

        fs.writeFileSync(tempSourcePath, 'plain project notes', 'utf-8');
        jest.spyOn(formatConverterService, 'detectFormat').mockReturnValueOnce(extension.slice(1) as any);
        jest.spyOn(formatConverterService, 'getConverter').mockReturnValueOnce({
          parse: jest.fn(() => {
            throw new Error('not ticket-formatted');
          }),
          serialize: jest.fn(),
        } as any);

        try {
          await expect((command as any).fetchFromFile(tempSourcePath)).resolves.toEqual(
            expect.objectContaining({
              type: 'file',
              source: tempSourcePath,
              content: 'plain project notes',
            })
          );
        } finally {
          fs.unlinkSync(tempSourcePath);
        }
      }
    );

    it('still processes local file sources in dry-run mode', async () => {
      const { command } = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      const tempSourcePath = path.join(os.tmpdir(), 'wf-dry-run-source.md');

      fs.writeFileSync(tempSourcePath, 'plain project notes', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath], {
          dryRun: true,
        } as any);
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: tempSourcePath,
          exists: true,
        })
      );
      expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          endpoint: '/v1/messages',
        })
      );
    });
  });

  it('stores saved generated artifacts under the cwd namespace by default', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], { save: true, dryRun: true });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(path.join(os.homedir(), '.wf', 'consumer-app', 'jira'));
    expect(path.basename(preview.filePath)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-ticket-description\.md$/);
  });

  it('stores saved generated artifacts under the targeted repo namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], {
      save: true,
      repos: ['repo-a'],
      dryRun: true,
    });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(path.join(os.homedir(), '.wf', 'repo-a', 'jira'));
  });

  describe('repo-aware local source resolution', () => {
    it('resolves a filename-only source to the repo-scoped artifact directory', async () => {
      const { command } = await buildCommand();
      const repoName = 'service-tourv3';
      const repoBasePath = path.join('/tmp/consumer-app', repoName);
      const sourceName = 'itinerary-pdf-generation.md';
      const expectedSourcePath = path.join(os.homedir(), '.wf', repoName, sourceName);

      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === repoBasePath ||
          filePath === path.join(repoBasePath, sourceName) ||
          filePath === expectedSourcePath
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs(sourceName, [repoName], false);

      expect(resolvedSources).toEqual([expectedSourcePath]);
    });

    it('prefers repo matches over cwd when --repos is provided', async () => {
      const { command } = await buildCommand();
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === 'src/spec.md' ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md')
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs('src/spec.md', ['repo-a'], false);

      expect(resolvedSources).toEqual([path.join('/tmp/consumer-app/repo-a', 'src/spec.md')]);
    });

    it('allows selecting multiple repo matches for synthesis in interactive mode', async () => {
      const { command } = await buildCommand();
      const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md') ||
          filePath === path.join('/tmp/consumer-app/repo-b', 'src/spec.md')
        );
      });

      promptMock.mockResolvedValueOnce({
        selectedSources: [
          path.join('/tmp/consumer-app/repo-a', 'src/spec.md'),
          path.join('/tmp/consumer-app/repo-b', 'src/spec.md'),
        ],
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      const resolvedSources = await (command as any).resolveSourceInputs('src/spec.md', ['repo-a', 'repo-b'], false);

      expect(resolvedSources).toEqual([
        path.join('/tmp/consumer-app/repo-a', 'src/spec.md'),
        path.join('/tmp/consumer-app/repo-b', 'src/spec.md'),
      ]);
      expect(promptMock).toHaveBeenCalled();
    });

    it('fails in silent mode when a relative source matches multiple repos', async () => {
      const { command } = await buildCommand();
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md') ||
          filePath === path.join('/tmp/consumer-app/repo-b', 'src/spec.md')
        );
      });

      await expect((command as any).resolveSourceInputs('src/spec.md', ['repo-a', 'repo-b'], true)).rejects.toThrow(
        'matches multiple repositories'
      );
    });

    it('does not treat ~/.wf artifacts as local source files', async () => {
      const { command } = await buildCommand();
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return filePath === path.join(os.homedir(), '.wf', 'src/spec.md');
      });

      await expect((command as any).fetchSource('src/spec.md')).rejects.toThrow('Unknown source type');
    });

    it('warns when a repo identifier cannot be resolved', async () => {
      const { command } = await buildCommand();
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md')
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs(
        'src/spec.md',
        ['missing-repo', 'repo-a'],
        false
      );

      expect(resolvedSources).toEqual([path.join('/tmp/consumer-app/repo-a', 'src/spec.md')]);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Repository 'missing-repo'"));
    });
  });

  describe('unresolved local source diagnostics', () => {
    it('explains that unresolved artifact filenames require --repos', async () => {
      const { command } = await buildCommand();
      const errorHandlerSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((() => {
        throw new Error('handled');
      }) as any);

      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(false);

      await expect(command.run(['2026-04-05-broadened-ai-config-docs-cleanup-plan.md'])).rejects.toThrow('handled');

      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('2026-04-05-broadened-ai-config-docs-cleanup-plan.md'),
        })
      );
      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('--repos'),
        })
      );

      errorHandlerSpy.mockRestore();
    });

    it('does not preview AI synthesis in dry-run mode when no source resolves', async () => {
      const { command } = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
      const errorHandlerSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((() => {
        throw new Error('handled');
      }) as any);

      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(false);

      await expect(
        command.run(['2026-04-05-broadened-ai-config-docs-cleanup-plan.md'], {
          dryRun: true,
        })
      ).rejects.toThrow('handled');

      expect(dryRunPreview.previewApiCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          endpoint: '/v1/messages',
        })
      );
      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('--repos'),
        })
      );

      errorHandlerSpy.mockRestore();
    });
  });

  describe('multi-repo save targets', () => {
    it('prompts for save targets only after synthesis succeeds', async () => {
      const { command } = await buildCommand();
      const aiService = (command as any).aiService as jest.Mocked<AiService>;
      const saveTicketLocallySpy = jest
        .spyOn(command as any, 'saveTicketLocally')
        .mockResolvedValue('/tmp/generated.md');
      const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      const tempSourcePath = path.join(os.tmpdir(), 'wf-issue-generate-save.md');

      fs.writeFileSync(tempSourcePath, 'Short source content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          jest.requireActual('fs').existsSync(filePath) ||
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b')
        );
      });

      promptMock.mockResolvedValueOnce({ selectedRepos: ['repo-a'] });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      try {
        await command.run([tempSourcePath], {
          save: true,
          repos: ['repo-a', 'repo-b'],
        });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(aiService.execute).toHaveBeenCalled();
      expect(promptMock).toHaveBeenCalled();
      expect(saveTicketLocallySpy).toHaveBeenCalledTimes(1);
      expect(saveTicketLocallySpy).toHaveBeenCalledWith(expect.anything(), 'jira', 'md', [tempSourcePath], 'repo-a');
    });

    it('fails in silent mode when --save targets multiple repos', async () => {
      const { command } = await buildCommand();
      const errorHandlerSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((() => {
        throw new Error('handled');
      }) as any);
      const tempSourcePath = path.join(os.tmpdir(), 'wf-issue-generate-silent-save.md');

      fs.writeFileSync(tempSourcePath, 'Short source content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          jest.requireActual('fs').existsSync(filePath) ||
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b')
        );
      });

      try {
        await expect(
          command.run([tempSourcePath], {
            save: true,
            repos: ['repo-a', 'repo-b'],
            silent: true,
          } as any)
        ).rejects.toThrow('handled');
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('multiple repositories'),
        })
      );

      errorHandlerSpy.mockRestore();
    });
  });

  it('saves the readable artifact stem and a reversible source manifest', async () => {
    const { command } = await buildCommand();
    const ticket = {
      title: 'Generated Title',
      description: 'Generated summary',
      type: 'task',
      priority: 'medium',
    } as any;

    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([]);

    const savedPath = await (command as any).saveTicketLocally(ticket, 'jira', 'md', [
      'https://example.com/spec',
      './notes.md',
    ]);

    expect(path.basename(savedPath)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-ticket-description\.md$/);

    const artifactWrite = writeFileSpy.mock.calls.find(
      ([filePath]) => String(filePath).endsWith('ticket-description.md') && !String(filePath).endsWith('.sources.json')
    );
    const manifestWrite = writeFileSpy.mock.calls.find(([filePath]) => String(filePath).endsWith('.sources.json'));

    expect(artifactWrite).toBeDefined();
    expect(manifestWrite).toBeDefined();

    const manifest = JSON.parse(String(manifestWrite?.[1]));
    expect(manifest.sources).toEqual(['https://example.com/spec', './notes.md']);
    expect(manifest.hash).toBe(hashGeneratedTicketSources(['https://example.com/spec', './notes.md']));
  });

  describe('formal writing conventions enforcement', () => {
    it('expands contractions in synthesised AI output before writing generated stdout content', async () => {
      const { command, mockAiService } = await buildCommand();
      const formatConverterService = (command as any).formatConverterService as jest.Mocked<FormatConverterService>;
      const outputLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const tempSourcePath = path.join(os.tmpdir(), 'wf-issue-generate-contraction-source.md');

      mockAiService.execute.mockResolvedValueOnce({
        content: [
          "# Generated Title That Don't Work",
          '',
          '**Type:** task',
          '**Priority:** medium',
          '',
          '## Description',
          '',
          '### Summary',
          "It's a summary that can't be used as-is",
        ].join('\n'),
      });
      jest.spyOn(formatConverterService, 'getConverter').mockImplementation(((format: string) => {
        if (format === 'md') {
          return {
            parse: jest.fn(() => ({
              title: "Generated Title That Don't Work",
              description: "It's a summary that can't be used as-is and shouldn't stay.",
              type: 'task',
              priority: 'medium',
            })),
            serialize: jest.fn(ticket => [`# ${ticket.title}`, '', ticket.description].join('\n')),
          } as any;
        }

        return {
          parse: jest.fn(),
          serialize: jest.fn(),
        } as any;
      }) as any);

      fs.writeFileSync(tempSourcePath, 'Short source content', 'utf-8');

      try {
        await command.run([tempSourcePath], { format: 'md' });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const serializedOutput = outputLogSpy.mock.calls
        .flat()
        .map(value => String(value))
        .find(value => value.includes('# Generated Title'));

      expect(serializedOutput).toBeDefined();
      expect(serializedOutput).toContain('Generated Title That Do not Work');
      expect(serializedOutput).toContain('It is a summary that cannot be used');
      expect(serializedOutput).not.toMatch(/don't|can't|shouldn't|it's/i);
    });

    it('expands contractions in single-source imported tickets before writing --output files', async () => {
      const { command } = await buildCommand();
      const formatConverterService = (command as any).formatConverterService as jest.Mocked<FormatConverterService>;
      const outputPath = path.join(os.tmpdir(), 'wf-generated-output.md');
      const tempSourcePath = path.join(os.tmpdir(), 'wf-imported-ticket-source.md');
      const importedTicket = {
        title: "Imported ticket that don't comply",
        description: "Imported description that can't be used and it's long enough to bypass synthesis. ".repeat(3),
        type: 'task',
        priority: 'medium',
      };

      jest.spyOn(formatConverterService, 'detectFormat').mockReturnValue('md');
      jest.spyOn(formatConverterService, 'getConverter').mockImplementation(((format: string) => {
        if (format === 'md') {
          return {
            parse: jest.fn(() => importedTicket),
            serialize: jest.fn(ticket => [`# ${ticket.title}`, '', ticket.description].join('\n')),
          } as any;
        }

        return {
          parse: jest.fn(),
          serialize: jest.fn(),
        } as any;
      }) as any);

      fs.writeFileSync(tempSourcePath, '# Imported ticket', 'utf-8');

      try {
        await command.run([tempSourcePath], {
          format: 'md',
          output: outputPath,
        });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const outputWrite = (fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>).mock.calls.find(
        ([filePath]) => String(filePath) === outputPath
      );

      expect(outputWrite).toBeDefined();
      expect(String(outputWrite?.[1])).toContain('Imported ticket that do not comply');
      expect(String(outputWrite?.[1])).toContain('Imported description that cannot be used');
      expect(String(outputWrite?.[1])).not.toMatch(/don't|can't|it's/i);
    });

    it('expands contractions in saved generated artifacts before persisting them', async () => {
      const { command } = await buildCommand();
      const formatConverterService = (command as any).formatConverterService as jest.Mocked<FormatConverterService>;
      const ticket = {
        title: "Generated Title That Don't Comply",
        description: "It's a summary that can't stay informal",
        type: 'task',
        priority: 'medium',
      } as any;

      (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([]);
      jest.spyOn(formatConverterService, 'getConverter').mockImplementation(((format: string) => {
        if (format === 'md') {
          return {
            parse: jest.fn(),
            serialize: jest.fn(currentTicket => [`# ${currentTicket.title}`, '', currentTicket.description].join('\n')),
          } as any;
        }

        return {
          parse: jest.fn(),
          serialize: jest.fn(),
        } as any;
      }) as any);

      await (command as any).saveTicketLocally(ticket, 'jira', 'md', ['https://example.com/spec']);

      const artifactWrite = writeFileSpy.mock.calls.find(
        ([filePath]) =>
          String(filePath).endsWith('ticket-description.md') && !String(filePath).endsWith('.sources.json')
      );

      expect(artifactWrite).toBeDefined();
      expect(String(artifactWrite?.[1])).toContain('Generated Title That Do not Comply');
      expect(String(artifactWrite?.[1])).toContain('It is a summary that cannot stay informal');
      expect(String(artifactWrite?.[1])).not.toMatch(/don't|can't|it's/i);
    });
  });

  describe('Slack source handling', () => {
    it('formats bare Slack archive URLs as chronological conversation artifacts with thread-style filenames', async () => {
      const { command } = await buildCommand();
      const slackService = (command as any).slackService as jest.Mocked<SlackService>;

      slackService.fetchChannelHistory.mockResolvedValue({
        channelId: 'C0AP5MMCP53',
        messages: [
          {
            ts: '1712345678.123456',
            user: 'U456',
            text: 'Latest follow-up',
          },
          {
            ts: '1712345600.000001',
            user: 'U123',
            text: 'Initial MPDM context',
          },
        ],
      } as any);

      const result = await (command as any).fetchSource('https://touraxis.slack.com/archives/C0AP5MMCP53');

      expect(slackService.fetchChannelHistory).toHaveBeenCalledWith('C0AP5MMCP53', 50);
      expect(result).toEqual(
        expect.objectContaining({
          type: 'slack',
          source: 'https://touraxis.slack.com/archives/C0AP5MMCP53',
          content: [
            '[1712345600.000001] U123: Initial MPDM context',
            '[1712345678.123456] U456: Latest follow-up',
          ].join('\n'),
        })
      );
      expect(writeFileSpy).toHaveBeenCalledWith(
        path.join(os.homedir(), '.wf', 'consumer-app', 'slack', 'slack-thread-C0AP5MMCP53-1712345600-000001.md'),
        ['[1712345600.000001] U123: Initial MPDM context', '[1712345678.123456] U456: Latest follow-up'].join('\n'),
        'utf-8'
      );
    });

    it('keeps Slack thread permalinks on the existing thread fetch path', async () => {
      const { command } = await buildCommand();
      const slackService = (command as any).slackService as jest.Mocked<SlackService>;

      slackService.fetchThread.mockResolvedValue({
        channelId: 'C0AP5MMCP53',
        threadTs: '1712345678.123456',
        messages: [
          {
            ts: '1712345678.123456',
            user: 'U123',
            text: 'Existing thread flow',
          },
        ],
      });

      await (command as any).fetchSource('https://touraxis.slack.com/archives/C0AP5MMCP53/p1712345678123456');

      expect(slackService.fetchThread).toHaveBeenCalledWith('C0AP5MMCP53', '1712345678.123456');
      expect(slackService.fetchChannelHistory).not.toHaveBeenCalled();
    });

    it('routes Slack thread permalinks with query params to the existing thread fetch path', async () => {
      const { command } = await buildCommand();
      const slackService = (command as any).slackService as jest.Mocked<SlackService>;

      slackService.fetchThread.mockResolvedValue({
        channelId: 'C0AP5MMCP53',
        threadTs: '1775650646.860809',
        messages: [
          {
            ts: '1775650646.860809',
            user: 'U123',
            text: 'Thread permalink with query params',
          },
        ],
      });

      await (command as any).fetchSource(
        'https://touraxis.slack.com/archives/C0AP5MMCP53/p1775650646860809?thread_ts=1775650646.860809&cid=C0AP5MMCP53'
      );

      expect(slackService.fetchThread).toHaveBeenCalledWith('C0AP5MMCP53', '1775650646.860809');
      expect(slackService.fetchChannelHistory).not.toHaveBeenCalled();
    });

    it('shows Slack history API preview for bare Slack channel archive URLs in dry-run mode', async () => {
      const { command } = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

      await command.run(['https://touraxis.slack.com/archives/C0AP5MMCP53'], {
        dryRun: true,
      });

      expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://slack.com/api/conversations.history',
          platform: 'Slack',
        })
      );
      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(
            os.homedir(),
            '.wf',
            'consumer-app',
            'slack',
            'slack-thread-C0AP5MMCP53-<oldest-message-ts>.md'
          ),
          format: 'md',
        })
      );
    });

    it('shows Slack thread API preview for Slack thread permalinks with query params in dry-run mode', async () => {
      const { command } = await buildCommand();
      const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

      await command.run(
        [
          'https://touraxis.slack.com/archives/C0AP5MMCP53/p1775650646860809?thread_ts=1775650646.860809&cid=C0AP5MMCP53',
        ],
        {
          dryRun: true,
        }
      );

      expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://slack.com/api/conversations.replies',
          platform: 'Slack',
        })
      );
      expect(dryRunPreview.previewApiCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint:
            'https://touraxis.slack.com/archives/C0AP5MMCP53/p1775650646860809?thread_ts=1775650646.860809&cid=C0AP5MMCP53',
          platform: 'Web',
        })
      );
      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(
            os.homedir(),
            '.wf',
            'consumer-app',
            'slack',
            'slack-thread-C0AP5MMCP53-1775650646-860809.md'
          ),
          format: 'md',
        })
      );
    });

    it('stops instead of synthesizing an empty ticket when all Slack sources fail', async () => {
      const { command } = await buildCommand();
      const slackService = (command as any).slackService as jest.Mocked<SlackService>;
      const aiService = (command as any).aiService as jest.Mocked<AiService>;
      const errorHandlerSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((() => {
        throw new Error('handled');
      }) as any);

      slackService.fetchChannelHistory.mockRejectedValue(new Error('Slack channel C0AP5MMCP53 not found'));

      await expect(command.run(['https://touraxis.slack.com/archives/C0AP5MMCP53'])).rejects.toThrow('handled');

      expect(aiService.execute).not.toHaveBeenCalled();

      errorHandlerSpy.mockRestore();
    });
  });

  describe('disambiguation prompt separation', () => {
    const setupMultiRepoMatch = () => {
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md') ||
          filePath === path.join('/tmp/consumer-app/repo-b', 'src/spec.md')
        );
      });
    };

    it('prompts interactively for multi-repo disambiguation when TTY and not silent', async () => {
      const { command } = await buildCommand();
      const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      setupMultiRepoMatch();
      promptMock.mockResolvedValueOnce({
        selectedSources: [path.join('/tmp/consumer-app/repo-a', 'src/spec.md')],
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      await (command as any).resolveRepoRelativeSources('src/spec.md', ['repo-a', 'repo-b'], false);

      expect(promptMock).toHaveBeenCalled();
    });

    it('fails with a non-TTY error when no TTY is available', async () => {
      const { command } = await buildCommand();
      setupMultiRepoMatch();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      await expect(
        (command as any).resolveRepoRelativeSources('src/spec.md', ['repo-a', 'repo-b'], false)
      ).rejects.toThrow('interactive terminal');
    });

    it('fails with a silent-mode error when --silent is active', async () => {
      const { command } = await buildCommand();
      setupMultiRepoMatch();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      await expect(
        (command as any).resolveRepoRelativeSources('src/spec.md', ['repo-a', 'repo-b'], true)
      ).rejects.toThrow('silent mode');
    });
  });

  describe('interactive clarification prompts', () => {
    let promptMock: jest.MockedFunction<typeof inquirer.prompt>;

    beforeEach(() => {
      promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
      promptMock.mockReset();
    });

    it('prompts user to clarify AI-identified ambiguities when not silent', async () => {
      const { command, mockAiService } = await buildCommand();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      const mockQuestions = ['What is the target platform?', 'Is SSO required?'];

      // First AI call: clarification
      mockAiService.execute.mockResolvedValueOnce({
        content: JSON.stringify(mockQuestions),
      });
      // Second AI call: synthesis
      mockAiService.execute.mockResolvedValueOnce({
        content: [
          '# Clarified Title',
          '',
          '**Type:** task',
          '**Priority:** medium',
          '',
          '## Description',
          '',
          '### Summary',
          'Clarified summary',
          '',
          '#### Technical Details',
          'None',
          '',
          '### Acceptance Criteria',
          '- None',
          '',
          '### Risks & Assumptions',
          '- None',
          '',
          '#### Out of Scope',
          '- None',
        ].join('\n'),
      });

      promptMock.mockResolvedValueOnce({ answer: 'Web only' }).mockResolvedValueOnce({ answer: 'No' });

      const tempSourcePath = path.join(os.tmpdir(), 'wf-clarify-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath]);
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(promptMock).toHaveBeenCalledTimes(2);
      expect(promptMock).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ message: 'What is the target platform?' })])
      );
      // Clarification prompt should instruct AI to skip already-acknowledged issues
      const clarificationCall = mockAiService.execute.mock.calls[0];
      expect(clarificationCall[0].prompt).toContain('Do NOT raise issues that the sources already acknowledge');
      // Synthesis call should include user clarifications in its prompt
      const synthesisCall = mockAiService.execute.mock.calls[1];
      expect(synthesisCall[0].prompt).toContain('user-clarifications');
    });

    it('skips clarification when AI identifies no ambiguities', async () => {
      const { command, mockAiService } = await buildCommand();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      // First AI call: clarification returns empty
      mockAiService.execute.mockResolvedValueOnce({
        content: '[]',
      });
      // Second AI call: synthesis
      mockAiService.execute.mockResolvedValueOnce({
        content: [
          '# Title',
          '',
          '**Type:** task',
          '**Priority:** medium',
          '',
          '## Description',
          '',
          '### Summary',
          'Summary',
          '',
          '#### Technical Details',
          'None',
          '',
          '### Acceptance Criteria',
          '- None',
          '',
          '### Risks & Assumptions',
          '- None',
          '',
          '#### Out of Scope',
          '- None',
        ].join('\n'),
      });

      const tempSourcePath = path.join(os.tmpdir(), 'wf-no-clarify-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath]);
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(promptMock).not.toHaveBeenCalled();
    });

    it('skips clarification in silent mode', async () => {
      const { command, mockAiService } = await buildCommand();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      const tempSourcePath = path.join(os.tmpdir(), 'wf-silent-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath], { silent: true });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      // Only the synthesis call should fire, not a clarification call
      expect(mockAiService.execute).toHaveBeenCalledTimes(1);
      expect(promptMock).not.toHaveBeenCalled();
    });

    it('skips clarification in non-TTY sessions', async () => {
      const { command, mockAiService } = await buildCommand();
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      const tempSourcePath = path.join(os.tmpdir(), 'wf-notty-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath]);
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      // Only synthesis call, no clarification
      expect(mockAiService.execute).toHaveBeenCalledTimes(1);
      expect(promptMock).not.toHaveBeenCalled();
    });

    it('propagates empty clarification responses instead of silently treating them as []', async () => {
      const { command, mockAiService } = await buildCommand();
      const errorHandlerSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((() => {
        throw new Error('handled');
      }) as any);
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      mockAiService.execute.mockResolvedValueOnce({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
      });

      const tempSourcePath = path.join(os.tmpdir(), 'wf-empty-clarify-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await expect(command.run([tempSourcePath])).rejects.toThrow('handled');
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'AI provider returned an empty clarification response',
          details: expect.objectContaining({
            provider: 'openai',
            model: 'gpt-5.4',
          }),
        })
      );

      errorHandlerSpy.mockRestore();
    });
  });

  describe('silent mode output', () => {
    beforeEach(() => {
      (inquirer.prompt as unknown as jest.Mock).mockReset();
    });

    it('prints only the saved file path when --save --silent', async () => {
      const { command } = await buildCommand();

      const tempSourcePath = path.join(os.tmpdir(), 'wf-save-silent-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath], { silent: true, save: true });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const logCalls = consoleLogSpy.mock.calls.map((args: unknown[]) => args[0]);
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toMatch(/\.wf.*jira.*ticket-description\.md$/);
    });

    it('prints only the output path when --output --silent', async () => {
      const { command } = await buildCommand();

      const tempSourcePath = path.join(os.tmpdir(), 'wf-output-silent-test.md');
      const outputPath = path.join(os.tmpdir(), 'wf-output-silent-out.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );
      (fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>).mockImplementation(() => {});

      try {
        await command.run([tempSourcePath], {
          silent: true,
          output: outputPath,
        });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const logCalls = consoleLogSpy.mock.calls.map((args: unknown[]) => args[0]);
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toBe(outputPath);
    });

    it('prints only raw ticket content when --silent without --save or --output', async () => {
      const { command } = await buildCommand();

      const tempSourcePath = path.join(os.tmpdir(), 'wf-raw-silent-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath], { silent: true });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const logCalls = consoleLogSpy.mock.calls.map((args: unknown[]) => args[0]);
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toContain('Generated Title');
    });

    it('suppresses progress and tip messages in silent mode', async () => {
      const { command } = await buildCommand();

      const tempSourcePath = path.join(os.tmpdir(), 'wf-suppress-silent-test.md');
      fs.writeFileSync(tempSourcePath, 'Some requirements content', 'utf-8');
      (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockImplementation(input =>
        jest.requireActual('fs').existsSync(String(input))
      );

      try {
        await command.run([tempSourcePath], { silent: true });
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      const allOutput = consoleLogSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
      expect(allOutput).not.toContain('Fetching:');
      expect(allOutput).not.toContain('Using AI to synthesize');
      expect(allOutput).not.toContain('Tip:');
      expect(allOutput).not.toContain('Generating Ticket');
    });
  });

  describe('onProgress threading', () => {
    it('passes onProgress to generateFromPrompt when agent mode is enabled and not silent', async () => {
      const { command, mockStageAgentService } = await buildCommand({
        generateAgentEnabled: true,
      });

      await (command as any).synthesizeWithAI(
        [
          { type: 'file', source: './a.md', content: 'Source A' },
          { type: 'file', source: './b.md', content: 'Source B' },
        ],
        false,
        undefined,
        jest.fn()
      );

      expect(mockStageAgentService.generateFromPrompt).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
    });

    it('passes undefined onProgress to generateFromPrompt when silent', async () => {
      const { command, mockStageAgentService } = await buildCommand({
        generateAgentEnabled: true,
      });

      await (command as any).synthesizeWithAI(
        [
          { type: 'file', source: './a.md', content: 'Source A' },
          { type: 'file', source: './b.md', content: 'Source B' },
        ],
        true,
        undefined,
        undefined
      );

      expect(mockStageAgentService.generateFromPrompt).toHaveBeenCalledWith(expect.any(String), undefined);
    });
  });

  describe('synthesizeWithAI always invokes AI', () => {
    it('calls AI even for a single source with a long description', async () => {
      const { command, mockAiService } = await buildCommand();

      const sources = [
        {
          type: 'tracker',
          source: 'WBP-3371',
          content: 'Title\n\n' + 'A '.repeat(200),
          ticket: {
            title: 'Existing ticket title',
            description: 'A '.repeat(200),
            type: 'bug',
            priority: 'high',
          },
        },
      ];

      await (command as any).synthesizeWithAI(sources, true, undefined, undefined);

      expect(mockAiService.execute).toHaveBeenCalled();
    });
  });

  describe('parseTrackerSource', () => {
    it('parses a configured baseUrl browse URL', async () => {
      const { command } = await buildCommand();
      const configService = (command as any).configService as ConfigService;
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'atlassian.baseUrl') return 'https://touraxis.atlassian.net';
        if (key === 'tracker') return 'jira';
        return undefined;
      });

      const result = (command as any).parseTrackerSource('https://touraxis.atlassian.net/browse/WBP-3371');
      expect(result).toEqual({ ticketKey: 'WBP-3371' });
    });

    it('parses a well-known atlassian.net browse URL without config', async () => {
      const { command } = await buildCommand();
      const configService = (command as any).configService as ConfigService;
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'atlassian.baseUrl') return undefined;
        if (key === 'tracker') return 'jira';
        return undefined;
      });

      const result = (command as any).parseTrackerSource('https://other-org.atlassian.net/browse/PROJ-42');
      expect(result).toEqual({ ticketKey: 'PROJ-42' });
    });

    it('handles trailing slash', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource('https://touraxis.atlassian.net/browse/WBP-3371/');
      expect(result).toEqual({ ticketKey: 'WBP-3371' });
    });

    it('ignores query params and hash fragments', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource(
        'https://touraxis.atlassian.net/browse/WBP-3371?focusedId=123#comment-123'
      );
      expect(result).toEqual({ ticketKey: 'WBP-3371' });
    });

    it('returns null for Confluence URLs', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource('https://touraxis.atlassian.net/wiki/spaces/DEV/pages/123');
      expect(result).toBeNull();
    });

    it('returns null for Jira board URLs', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource(
        'https://touraxis.atlassian.net/jira/software/projects/WBP/boards/1'
      );
      expect(result).toBeNull();
    });

    it('returns null for non-Atlassian URLs', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource('https://github.com/org/repo/issues/42');
      expect(result).toBeNull();
    });

    it('returns null for bare ticket keys', async () => {
      const { command } = await buildCommand();

      const result = (command as any).parseTrackerSource('WBP-3371');
      expect(result).toBeNull();
    });

    it('returns null for self-hosted Jira without config', async () => {
      const { command } = await buildCommand();
      const configService = (command as any).configService as ConfigService;
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'atlassian.baseUrl') return undefined;
        if (key === 'tracker') return 'jira';
        return undefined;
      });

      const result = (command as any).parseTrackerSource('https://jira.mycompany.com/browse/PROJ-1');
      expect(result).toBeNull();
    });

    it('parses self-hosted Jira when config matches', async () => {
      const { command } = await buildCommand();
      const configService = (command as any).configService as ConfigService;
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'atlassian.baseUrl') return 'https://jira.mycompany.com';
        if (key === 'tracker') return 'jira';
        return undefined;
      });

      const result = (command as any).parseTrackerSource('https://jira.mycompany.com/browse/PROJ-1');
      expect(result).toEqual({ ticketKey: 'PROJ-1' });
    });
  });

  describe('fetchSource routes Jira browse URLs through tracker', () => {
    it('calls fetchFromTracker for Jira browse URLs instead of fetchFromUrl', async () => {
      const { command } = await buildCommand();
      const fetchFromTrackerSpy = jest
        .spyOn(command as any, 'fetchFromTracker')
        .mockResolvedValue({ type: 'ticket', source: 'WBP-3371', content: 'Ticket content' });
      const fetchFromUrlSpy = jest
        .spyOn(command as any, 'fetchFromUrl')
        .mockResolvedValue({ type: 'url', source: 'https://touraxis.atlassian.net/browse/WBP-3371', content: 'HTML' });

      await (command as any).fetchSource('https://touraxis.atlassian.net/browse/WBP-3371', 'jira', 'my-repo');

      expect(fetchFromTrackerSpy).toHaveBeenCalledWith('WBP-3371', 'jira', 'my-repo');
      expect(fetchFromUrlSpy).not.toHaveBeenCalled();
    });
  });
});
