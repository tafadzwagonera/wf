import * as path from 'path';
import { readSkillContent, buildSkillPromptFragment, fragmentIncludesSkill, TDD_SKILL_ID } from './skill-content';
import { ConfigurationError } from '../common/errors/app.error';
import * as logFileWriter from '../common/logger/log-file-writer';

jest.mock('../common/utils/runtime-assets');

import { readRuntimeAsset } from '../common/utils/runtime-assets';

const mockReadAsset = readRuntimeAsset as jest.MockedFunction<typeof readRuntimeAsset>;

const bundledPath = (skillId: string) =>
  path.join(__dirname, 'content', skillId, 'SKILL.md');

const noopColor = (s: string) => s;

describe('readSkillContent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns file content when SKILL.md is found at the bundled path', async () => {
    mockReadAsset.mockReturnValueOnce('# My Skill\nDo something.');

    const result = await readSkillContent('my-skill');
    expect(result).toBe('# My Skill\nDo something.');
    expect(mockReadAsset).toHaveBeenCalledWith('skills/my-skill/SKILL.md', bundledPath('my-skill'));
  });

  it('returns null when SKILL.md is not found at the bundled path', async () => {
    mockReadAsset.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await readSkillContent('missing-skill');
    expect(result).toBeNull();
  });
});

describe('buildSkillPromptFragment', () => {
  let mockAppendToLogFile: jest.SpyInstance;

  beforeEach(() => {
    mockAppendToLogFile = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

    const knownSkillIds = new Set(['my-skill', 'skill-a', 'skill-b']);
    mockReadAsset.mockImplementation((assetKey: string) => {
      const skillId = /^skills\/([^/]+)\/SKILL\.md$/.exec(assetKey)?.[1];
      if (skillId && knownSkillIds.has(skillId)) return '# Skill content';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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

describe('fragmentIncludesSkill', () => {
  it('returns true when a line is exactly the skill header', () => {
    expect(fragmentIncludesSkill(`\n\n## Skill: ${TDD_SKILL_ID}\n# body`, TDD_SKILL_ID)).toBe(true);
  });

  it('returns false for undefined and empty fragments', () => {
    expect(fragmentIncludesSkill(undefined, TDD_SKILL_ID)).toBe(false);
    expect(fragmentIncludesSkill('', TDD_SKILL_ID)).toBe(false);
  });

  it('returns false for another skill fragment', () => {
    expect(fragmentIncludesSkill('\n\n## Skill: coding-style\n# body', TDD_SKILL_ID)).toBe(false);
  });

  it('returns false when the id appears mid-line in prose', () => {
    expect(fragmentIncludesSkill(`see ## Skill: ${TDD_SKILL_ID} for details`, TDD_SKILL_ID)).toBe(false);
  });

  it('matches regex metacharacters in the id literally', () => {
    expect(fragmentIncludesSkill('## Skill: a.b', 'a.b')).toBe(true);
    expect(fragmentIncludesSkill('## Skill: axb', 'a.b')).toBe(false);
  });
});
