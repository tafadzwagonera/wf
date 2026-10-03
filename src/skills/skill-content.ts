import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigurationError } from '../shared/errors/app.error';
import { appendToLogFile } from '../shared/logger/log-file-writer';

/** Returns the raw SKILL.md content for the given skill, or null if the bundled file cannot be read. */
export const readSkillContent = async (skillId: string): Promise<string | null> => {
  try {
    return await fs.readFile(path.join(__dirname, 'content', skillId, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
};

const loadOneSkill = async (skillId: string, backend: string, color: (text: string) => string): Promise<string> => {
  const content = await readSkillContent(skillId);
  if (content === null) {
    throw new ConfigurationError(
      `SKILL.md not found for skill "${skillId}". Searched: ${path.join(__dirname, 'content', skillId, 'SKILL.md')}`
    );
  }
  console.log(color(`  [${backend}] Skill('${skillId}') loaded`));
  appendToLogFile('INFO', `Skill('${skillId}') loaded`, backend);
  return `## Skill: ${skillId}\n${content.trimEnd()}`;
};

/** Builds a prompt fragment from bundled SKILL.md files. Throws ConfigurationError if any skill has no bundled file. */
export const buildSkillPromptFragment = async (
  skillIds: string[],
  backend: string,
  color: (text: string) => string,
): Promise<string> => {
  if (!skillIds.length) return '';
  const sections = await Promise.all(skillIds.map(id => loadOneSkill(id, backend, color)));
  return `\n\n${sections.join('\n\n')}`;
};
