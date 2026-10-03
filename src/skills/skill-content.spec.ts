import * as path from 'path';
import { readSkillContent, buildSkillPromptFragment } from './skill-content';
import { ConfigurationError } from '../shared/errors/app.error';
import * as logFileWriter from '../shared/logger/log-file-writer';

jest.mock('fs/promises');

import * as fs from 'fs/promises';

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

const bundledPath = (skillId: string) =>
  path.join(__dirname, 'content', skillId, 'SKILL.md');

const noopColor = (s: string) => s;

describe('readSkillContent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns file content when SKILL.md is found at the bundled path', async () => {
    mockReadFile.mockResolvedValueOnce('# My Skill\nDo something.' as never);

    const result = await readSkillContent('my-skill');
    expect(result).toBe('# My Skill\nDo something.');
    expect(mockReadFile).toHaveBeenCalledWith(bundledPath('my-skill'), 'utf-8');
  });

  it('returns null when SKILL.md is not found at the bundled path', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await readSkillContent('missing-skill');
    expect(result).toBeNull();
  });
});

describe('buildSkillPromptFragment', () => {
  let mockAppendToLogFile: jest.SpyInstance;

  beforeEach(() => {
    mockAppendToLogFile = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

    const knownSkillIds = new Set(['my-skill', 'skill-a', 'skill-b']);
    mockReadFile.mockImplementation((filePath: unknown) => {
      const p = filePath as string;
      const skillId = /content\/([^/]+)\/SKILL\.md$/.exec(p)?.[1];
      if (skillId && knownSkillIds.has(skillId)) {
        return Promise.resolve('# Skill content' as never);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty string when skillIds array is empty', async () => {
    const result = await buildSkillPromptFragment([], 'test-backend', noopColor);
    expect(result).toBe('');
  });

  it('concatenates SKILL.md content for multiple skills under headers', async () => {
    const result = await buildSkillPromptFragment(['skill-a', 'skill-b'], 'test-backend', noopColor);
    expect(result).toContain('## Skill: skill-a');
    expect(result).toContain('# Skill content');
    expect(result).toContain('## Skill: skill-b');
  });

  it('calls appendToLogFile once per successfully loaded skill', async () => {
    await buildSkillPromptFragment(['skill-a', 'skill-b'], 'test-backend', noopColor);

    expect(mockAppendToLogFile).toHaveBeenCalledTimes(2);
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', "Skill('skill-a') loaded", 'test-backend');
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', "Skill('skill-b') loaded", 'test-backend');
  });

  it('wraps the console log line in the provided color function', async () => {
    const mockColor = jest.fn((s: string) => s);

    await buildSkillPromptFragment(['skill-a'], 'test-backend', mockColor);

    expect(mockColor).toHaveBeenCalledWith("  [test-backend] Skill('skill-a') loaded");
  });

  it('throws ConfigurationError when a SKILL.md is missing', async () => {
    await expect(
      buildSkillPromptFragment(['missing-skill'], 'test-backend', noopColor)
    ).rejects.toThrow(ConfigurationError);
  });

  it('includes the skill ID in the ConfigurationError message', async () => {
    await expect(
      buildSkillPromptFragment(['my-missing-skill'], 'test-backend', noopColor)
    ).rejects.toThrow('my-missing-skill');
  });

  it('does not call appendToLogFile when a skill fails to load', async () => {
    await expect(
      buildSkillPromptFragment(['missing-skill'], 'test-backend', noopColor)
    ).rejects.toThrow(ConfigurationError);

    expect(mockAppendToLogFile).not.toHaveBeenCalled();
  });
});
