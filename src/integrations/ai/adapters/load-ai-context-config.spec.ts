import { loadAiContextConfig } from './load-ai-context-config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs/promises');
jest.mock('chalk', () => ({
  yellow: (s: string) => s,
}));

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

describe('loadAiContextConfig', () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.clearAllMocks();
    process.cwd = jest.fn().mockReturnValue('/project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  describe('when both global and project config exist', () => {
    it('returns combined config block with both sections', async () => {
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).includes('.claude')) return 'global rules' as any;
        return 'project rules' as any;
      });

      const result = await loadAiContextConfig(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
      );

      expect(result).toBe(
        '## Global Config\nglobal rules\n\n## Project Config\nproject rules\n\n',
      );
    });
  });

  describe('when only global config exists', () => {
    it('returns only the global config block', async () => {
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).includes('.claude')) return 'global rules' as any;
        throw new Error('ENOENT');
      });

      const result = await loadAiContextConfig(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
      );

      expect(result).toBe('## Global Config\nglobal rules\n\n');
    });
  });

  describe('when only project config exists', () => {
    it('returns only the project config block', async () => {
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).includes('.claude')) throw new Error('ENOENT');
        return 'project rules' as any;
      });

      const result = await loadAiContextConfig(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
      );

      expect(result).toBe('## Project Config\nproject rules\n\n');
    });
  });

  describe('when no config exists', () => {
    it('returns empty string', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await loadAiContextConfig(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
      );

      expect(result).toBe('');
    });

    it('logs a chalk.yellow warning', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await loadAiContextConfig(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'No global or project-level configuration found for anthropic',
        ),
      );
      warnSpy.mockRestore();
    });
  });

  describe('when globalPath is null (DeepSeek)', () => {
    it('only reads project config file', async () => {
      mockReadFile.mockResolvedValue('project rules' as any);

      const result = await loadAiContextConfig(null, 'DEEPSEEK.md', 'deepseek');

      expect(result).toBe('## Project Config\nproject rules\n\n');
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledWith(
        '/project/DEEPSEEK.md',
        'utf-8',
      );
    });
  });
});
