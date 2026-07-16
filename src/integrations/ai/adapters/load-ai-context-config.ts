import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';

/**
 * Reads a single config file and returns a labelled section string, or null if unreadable.
 *
 * @param filePath - Absolute path to the file to read.
 * @param label - Section heading used in the returned string (e.g. `'Global Config'`).
 * @returns Labelled markdown section string, or `null` if the file could not be read.
 */
const readConfigFile = async (filePath: string, label: string): Promise<string | null> => {
  const content = await fs.readFile(filePath, 'utf-8').catch(() => null);
  return content === null ? null : `## ${label}\n${content}\n\n`;
};

/**
 * Reads global and project config files concurrently and returns non-null sections.
 *
 * @param globalPath - Absolute path to the global config file, or `null` to skip.
 * @param projectPath - Absolute path to the project-level config file.
 * @returns Array of labelled section strings for files that were successfully read.
 */
const readConfigSections = async (globalPath: string | null, projectPath: string): Promise<string[]> => {
  const [globalSection, projectSection] = await Promise.all([
    globalPath ? readConfigFile(globalPath, 'Global Config') : Promise.resolve(null),
    readConfigFile(projectPath, 'Project Config'),
  ]);
  return [globalSection, projectSection].filter((s): s is string => s !== null);
};

/**
 * Reads global and project-level config files for an AI provider and returns
 * a combined config block to prepend to system prompts.
 *
 * @param globalPath - Absolute path to the global config file, or null if no
 *   global config should be skipped.
 * @param projectFileName - Filename to look for in process.cwd() (e.g. 'CLAUDE.md').
 * @param providerName - Display name used in the warning message.
 * @param shouldWarnWhenMissing - Whether a missing config should emit a warning.
 * @returns Combined config block string, or empty string if no config found.
 */
export const loadAiContextConfig = async (
  globalPath: string | null,
  projectFileName: string,
  providerName: string,
  shouldWarnWhenMissing: boolean
): Promise<string> => {
  const sections = await readConfigSections(globalPath, path.join(process.cwd(), projectFileName));
  if (sections.length === 0 && shouldWarnWhenMissing) {
    console.warn(chalk.yellow(`⚠️ No global or project-level configuration found for ${providerName}`));
    return '';
  }
  return sections.join('');
};
