import { readSkillContent, buildSkillPromptFragment } from './skill-content';
import { ConfigurationError } from '../shared/errors/app.error';

jest.mock('fs/promises');
jest.mock('glob');

import * as fs from 'fs/promises';
import { glob } from 'glob';

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockGlob = glob as jest.MockedFunction<typeof glob>;

describe('readSkillContent', () => {
  beforeEach(() => {
    // Glob patterns with wildcards return no matches by default
    mockGlob.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('returns file content when SKILL.md is found via direct path', async () => {
    mockReadFile.mockResolvedValueOnce('# My Skill\nDo something.' as never);

    const result = await readSkillContent('my-skill');
    expect(result).toBe('# My Skill\nDo something.');
  });

  it('returns file content when SKILL.md is found via glob pattern', async () => {
    mockReadFile
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockGlob.mockResolvedValueOnce(['/home/.claude/plugins/cache/claude-plugins-official/v1/skills/glob-skill/SKILL.md'] as never);
    mockReadFile.mockResolvedValueOnce('# Glob Skill\nFound via wildcard.' as never);

    const result = await readSkillContent('glob-skill');
    expect(result).toBe('# Glob Skill\nFound via wildcard.');
  });

  it('returns null when SKILL.md is not found in any location', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await readSkillContent('missing-skill');
    expect(result).toBeNull();
  });
});

describe('buildSkillPromptFragment', () => {
  beforeEach(() => {
    mockGlob.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('returns empty string when skillIds array is empty', async () => {
    const result = await buildSkillPromptFragment([]);
    expect(result).toBe('');
  });

  it('concatenates SKILL.md content for multiple skills under headers', async () => {
    mockReadFile
      .mockResolvedValueOnce('Content for skill-a.' as never)
      .mockResolvedValueOnce('Content for skill-b.' as never);

    const result = await buildSkillPromptFragment(['skill-a', 'skill-b']);
    expect(result).toContain('## Skill: skill-a');
    expect(result).toContain('Content for skill-a.');
    expect(result).toContain('## Skill: skill-b');
    expect(result).toContain('Content for skill-b.');
  });

  it('throws ConfigurationError when a SKILL.md is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(buildSkillPromptFragment(['missing-skill'])).rejects.toThrow(ConfigurationError);
  });

  it('includes the skill ID in the ConfigurationError message', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(buildSkillPromptFragment(['my-missing-skill']))
      .rejects.toThrow('my-missing-skill');
  });
});
