import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { ConfigurationError } from '../shared/errors/app.error';

const buildSkillSearchPatterns = (skillId: string): string[] => [
  path.join(os.homedir(), '.claude', 'skills', skillId, 'SKILL.md'),
  path.join(os.homedir(), '.codex', 'skills', skillId, 'SKILL.md'),
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', '*', 'skills', skillId, 'SKILL.md'),
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', '*', '*', 'skills', skillId, 'SKILL.md'),
  path.join(os.homedir(), '.codex', 'superpowers', 'skills', skillId, 'SKILL.md'),
];

const tryRead = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const tryReadPattern = async (pattern: string): Promise<string | null> => {
  if (!pattern.includes('*')) return tryRead(pattern);
  const matches = await glob(pattern, { nodir: true });
  return matches.length > 0 ? tryRead(matches[0]) : null;
};

/**
 * Search for SKILL.md for the given skill ID across plugin directories.
 * Returns the file content if found, or null if not found in any location.
 *
 * @param skillId - The skill identifier to search for
 * @returns File content string or null
 */
export const readSkillContent = async (skillId: string): Promise<string | null> => {
  for (const pattern of buildSkillSearchPatterns(skillId)) {
    const content = await tryReadPattern(pattern);
    if (content !== null) return content;
  }
  return null;
};

/**
 * Build a prompt fragment by concatenating SKILL.md content for all given skill IDs.
 * Throws ConfigurationError if any skill's SKILL.md cannot be found.
 *
 * @param skillIds - List of skill identifiers
 * @returns Concatenated prompt fragment string
 */
export const buildSkillPromptFragment = async (skillIds: string[]): Promise<string> => {
  const sections: string[] = [];

  for (const skillId of skillIds) {
    const content = await readSkillContent(skillId);
    if (content === null) {
      const searchedPaths = buildSkillSearchPatterns(skillId).join('\n  ');
      throw new ConfigurationError(
        `SKILL.md not found for skill "${skillId}". Searched:\n  ${searchedPaths}`
      );
    }
    sections.push(`## Skill: ${skillId}\n${content.trimEnd()}`);
  }

  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
};
