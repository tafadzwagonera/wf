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
    ].forEach((name) => {
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
    promises: {
      ...actual.promises,
      mkdir: jest.fn(actual.promises.mkdir),
      writeFile: jest.fn(actual.promises.writeFile),
    },
  };
});

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    ),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueGenerateCommand } from './issue-generate.command';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { AiService } from '../integrations/ai/ai.service';
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

async function buildCommand(): Promise<IssueGenerateCommand> {
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
        '### Unit Test Scope',
        '- None',
        '',
        '#### Dependencies',
        '- None',
        '',
        '### Risks & Assumptions',
        '- None',
        '',
        '### Affected Repositories',
        '- None',
        '',
        '#### References',
        '- None',
        '',
        '#### Out of Scope',
        '- None',
      ].join('\n'),
    }),
  };
  const module = await Test.createTestingModule({
    providers: [
      IssueGenerateCommand,
      { provide: PlatformService, useValue: {} },
      {
        provide: FormatConverterService,
        useValue: {
          getConverter: jest.fn(() => ({
            serialize: jest.fn(),
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
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'output.defaultFormat') return 'md';
            if (key === 'platforms.primary') return 'jira';
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

  return module.get(IssueGenerateCommand);
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
    writeFileSpy = jest
      .spyOn(fs.promises, 'writeFile')
      .mockResolvedValue(undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReset();
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReset();
    (
      fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
    ).mockImplementation(jest.requireActual('fs').existsSync);
    (
      fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>
    ).mockImplementation(() => []);
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

  describe('AI stage routing', () => {
    it('uses the generate stage override when synthesizing ticket content', async () => {
      const command = await buildCommand();
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
        }),
      );
    });

    it('instructs the model to use fenced code blocks and hyphen bullets only', async () => {
      const command = await buildCommand();

      const prompt = (command as any).buildSynthesisPrompt([
        {
          type: 'file',
          source: './notes.md',
          content: 'Short notes that require synthesis',
        },
      ]);

      expect(prompt).toContain(
        'Use fenced Markdown code blocks (```lang) for code samples; never use Jira wiki {code} syntax.',
      );
      expect(prompt).toContain(
        'Use `- ` for every unordered bullet item; never use `* ` bullets.',
      );
    });
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const command = await buildCommand();

      expect(
        command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any),
      ).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  it('stores saved generated artifacts under the cwd namespace by default', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], { save: true, dryRun: true });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'consumer-app', 'jira'),
    );
    expect(path.basename(preview.filePath)).toMatch(
      /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-ticket-description\.md$/,
    );
  });

  it('stores saved generated artifacts under the targeted repo namespace when --repos is provided', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], {
      save: true,
      repos: ['repo-a'],
      dryRun: true,
    });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'repo-a', 'jira'),
    );
  });

  describe('repo-aware local source resolution', () => {
    it('resolves a filename-only source to the repo-scoped artifact directory', async () => {
      const command = await buildCommand();
      const repoName = 'service-tourv3';
      const repoBasePath = path.join('/tmp/consumer-app', repoName);
      const sourceName = 'itinerary-pdf-generation.md';
      const expectedSourcePath = path.join(
        os.homedir(),
        '.wf',
        repoName,
        sourceName,
      );

      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
        const filePath = String(input);
        return (
          filePath === repoBasePath ||
          filePath === path.join(repoBasePath, sourceName) ||
          filePath === expectedSourcePath
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs(
        sourceName,
        [repoName],
        false,
      );

      expect(resolvedSources).toEqual([expectedSourcePath]);
    });

    it('prefers repo matches over cwd when --repos is provided', async () => {
      const command = await buildCommand();
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === 'src/spec.md' ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md')
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs(
        'src/spec.md',
        ['repo-a'],
        false,
      );

      expect(resolvedSources).toEqual([
        path.join('/tmp/consumer-app/repo-a', 'src/spec.md'),
      ]);
    });

    it('allows selecting multiple repo matches for synthesis in interactive mode', async () => {
      const command = await buildCommand();
      const promptMock = inquirer.prompt as jest.MockedFunction<
        typeof inquirer.prompt
      >;
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
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

      const resolvedSources = await (command as any).resolveSourceInputs(
        'src/spec.md',
        ['repo-a', 'repo-b'],
        false,
      );

      expect(resolvedSources).toEqual([
        path.join('/tmp/consumer-app/repo-a', 'src/spec.md'),
        path.join('/tmp/consumer-app/repo-b', 'src/spec.md'),
      ]);
      expect(promptMock).toHaveBeenCalled();
    });

    it('fails in silent mode when a relative source matches multiple repos', async () => {
      const command = await buildCommand();
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app', 'repo-b') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md') ||
          filePath === path.join('/tmp/consumer-app/repo-b', 'src/spec.md')
        );
      });

      await expect(
        (command as any).resolveSourceInputs(
          'src/spec.md',
          ['repo-a', 'repo-b'],
          true,
        ),
      ).rejects.toThrow('matches multiple repositories');
    });

    it('does not treat ~/.wf artifacts as local source files', async () => {
      const command = await buildCommand();
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
        const filePath = String(input);
        return filePath === path.join(os.homedir(), '.wf', 'src/spec.md');
      });

      await expect((command as any).fetchSource('src/spec.md')).rejects.toThrow(
        'Unknown source type',
      );
    });

    it('warns when a repo identifier cannot be resolved', async () => {
      const command = await buildCommand();
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
        const filePath = String(input);
        return (
          filePath === path.join('/tmp/consumer-app', 'repo-a') ||
          filePath === path.join('/tmp/consumer-app/repo-a', 'src/spec.md')
        );
      });

      const resolvedSources = await (command as any).resolveSourceInputs(
        'src/spec.md',
        ['missing-repo', 'repo-a'],
        false,
      );

      expect(resolvedSources).toEqual([
        path.join('/tmp/consumer-app/repo-a', 'src/spec.md'),
      ]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Repository 'missing-repo'"),
      );
    });
  });

  describe('multi-repo save targets', () => {
    it('prompts for save targets only after synthesis succeeds', async () => {
      const command = await buildCommand();
      const aiService = (command as any).aiService as jest.Mocked<AiService>;
      const saveTicketLocallySpy = jest
        .spyOn(command as any, 'saveTicketLocally')
        .mockResolvedValue('/tmp/generated.md');
      const promptMock = inquirer.prompt as jest.MockedFunction<
        typeof inquirer.prompt
      >;
      const tempSourcePath = path.join(
        os.tmpdir(),
        'wf-issue-generate-save.md',
      );

      fs.writeFileSync(tempSourcePath, 'Short source content', 'utf-8');
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
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
      expect(saveTicketLocallySpy).toHaveBeenCalledWith(
        expect.anything(),
        'jira',
        'md',
        [tempSourcePath],
        'repo-a',
      );
    });

    it('fails in silent mode when --save targets multiple repos', async () => {
      const command = await buildCommand();
      const errorHandlerSpy = jest
        .spyOn(ErrorHandler, 'handle')
        .mockImplementation((() => {
          throw new Error('handled');
        }) as any);
      const tempSourcePath = path.join(
        os.tmpdir(),
        'wf-issue-generate-silent-save.md',
      );

      fs.writeFileSync(tempSourcePath, 'Short source content', 'utf-8');
      (
        fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
      ).mockImplementation((input) => {
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
          } as any),
        ).rejects.toThrow('handled');
      } finally {
        fs.unlinkSync(tempSourcePath);
      }

      expect(errorHandlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('multiple repositories'),
        }),
      );

      errorHandlerSpy.mockRestore();
    });
  });

  it('saves the readable artifact stem and a reversible source manifest', async () => {
    const command = await buildCommand();
    const ticket = {
      title: 'Generated Title',
      description: 'Generated summary',
      type: 'task',
      priority: 'medium',
    } as any;

    (
      fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>
    ).mockReturnValue([]);

    const savedPath = await (command as any).saveTicketLocally(
      ticket,
      'jira',
      'md',
      ['https://example.com/spec', './notes.md'],
    );

    expect(path.basename(savedPath)).toMatch(
      /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-ticket-description\.md$/,
    );

    const artifactWrite = writeFileSpy.mock.calls.find(
      ([filePath]) =>
        String(filePath).endsWith('ticket-description.md') &&
        !String(filePath).endsWith('.sources.json'),
    );
    const manifestWrite = writeFileSpy.mock.calls.find(([filePath]) =>
      String(filePath).endsWith('.sources.json'),
    );

    expect(artifactWrite).toBeDefined();
    expect(manifestWrite).toBeDefined();

    const manifest = JSON.parse(String(manifestWrite?.[1]));
    expect(manifest.sources).toEqual([
      'https://example.com/spec',
      './notes.md',
    ]);
    expect(manifest.hash).toBe(
      hashGeneratedTicketSources(['https://example.com/spec', './notes.md']),
    );
  });

  describe('Slack source handling', () => {
    it('formats bare Slack archive URLs as chronological conversation artifacts with thread-style filenames', async () => {
      const command = await buildCommand();
      const slackService = (command as any)
        .slackService as jest.Mocked<SlackService>;

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

      const result = await (command as any).fetchSource(
        'https://touraxis.slack.com/archives/C0AP5MMCP53',
      );

      expect(slackService.fetchChannelHistory).toHaveBeenCalledWith(
        'C0AP5MMCP53',
        50,
      );
      expect(result).toEqual(
        expect.objectContaining({
          type: 'slack',
          source: 'https://touraxis.slack.com/archives/C0AP5MMCP53',
          content: [
            '[1712345600.000001] U123: Initial MPDM context',
            '[1712345678.123456] U456: Latest follow-up',
          ].join('\n'),
        }),
      );
      expect(writeFileSpy).toHaveBeenCalledWith(
        path.join(
          os.homedir(),
          '.wf',
          'consumer-app',
          'slack',
          'slack-thread-C0AP5MMCP53-1712345600-000001.md',
        ),
        [
          '[1712345600.000001] U123: Initial MPDM context',
          '[1712345678.123456] U456: Latest follow-up',
        ].join('\n'),
        'utf-8',
      );
    });

    it('keeps Slack thread permalinks on the existing thread fetch path', async () => {
      const command = await buildCommand();
      const slackService = (command as any)
        .slackService as jest.Mocked<SlackService>;

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

      await (command as any).fetchSource(
        'https://touraxis.slack.com/archives/C0AP5MMCP53/p1712345678123456',
      );

      expect(slackService.fetchThread).toHaveBeenCalledWith(
        'C0AP5MMCP53',
        '1712345678.123456',
      );
      expect(slackService.fetchChannelHistory).not.toHaveBeenCalled();
    });

    it('shows Slack history API preview for bare Slack channel archive URLs in dry-run mode', async () => {
      const command = await buildCommand();
      const dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;

      await command.run(['https://touraxis.slack.com/archives/C0AP5MMCP53'], {
        dryRun: true,
      });

      expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://slack.com/api/conversations.history',
          platform: 'Slack',
        }),
      );
      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(
            os.homedir(),
            '.wf',
            'consumer-app',
            'slack',
            'slack-thread-C0AP5MMCP53-<oldest-message-ts>.md',
          ),
          format: 'md',
        }),
      );
    });

    it('stops instead of synthesizing an empty ticket when all Slack sources fail', async () => {
      const command = await buildCommand();
      const slackService = (command as any)
        .slackService as jest.Mocked<SlackService>;
      const aiService = (command as any).aiService as jest.Mocked<AiService>;
      const errorHandlerSpy = jest
        .spyOn(ErrorHandler, 'handle')
        .mockImplementation((() => {
          throw new Error('handled');
        }) as any);

      slackService.fetchChannelHistory.mockRejectedValue(
        new Error('Slack channel C0AP5MMCP53 not found'),
      );

      await expect(
        command.run(['https://touraxis.slack.com/archives/C0AP5MMCP53']),
      ).rejects.toThrow('handled');

      expect(aiService.execute).not.toHaveBeenCalled();

      errorHandlerSpy.mockRestore();
    });
  });
});
