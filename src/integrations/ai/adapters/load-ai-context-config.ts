import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';

/**
 * Reads global and project-level config files for an AI provider and returns
 * a combined config block to prepend to system prompts.
 *
 * @param globalPath - Absolute path to the global config file, or null if no
 *   standard global config exists for this provider (e.g. DeepSeek).
 * @param projectFileName - Filename to look for in process.cwd() (e.g. 'CLAUDE.md').
 * @param providerName - Display name used in the warning message.
 * @returns Combined config block string, or empty string if no config found.
 */
export const loadAiContextConfig = async (
  globalPath: string | null,
  projectFileName: string,
  providerName: string,
): Promise<string> => {
  const projectPath = path.join(process.cwd(), projectFileName);

  const [globalContent, projectContent] = await Promise.all([
    globalPath
      ? fs.readFile(globalPath, 'utf-8').catch(() => null)
      : Promise.resolve(null),
    fs.readFile(projectPath, 'utf-8').catch(() => null),
  ]);

  if (globalContent === null && projectContent === null) {
    console.warn(
      chalk.yellow(
        `⚠️ No global or project-level configuration found for ${providerName}`,
      ),
    );
    return '';
  }

  let result = '';
  if (globalContent !== null) {
    result += `## Global Config\n${globalContent}\n\n`;
  }
  if (projectContent !== null) {
    result += `## Project Config\n${projectContent}\n\n`;
  }
  return result;
};
