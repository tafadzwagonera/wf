import inquirer from 'inquirer';
import { detectRepoConventions } from './detect-repo-conventions';

const FIGMA_LINK_PATTERN = /https?:\/\/(www\.)?figma\.com\/(file|design|proto|board)\/[\w-]+(?:\/[^\s?#]*)*/gi;

const FIGMA_LINK_PROMPT_MESSAGE = 'Figma frame link(s), space-separated (optional, press Enter to skip) — '
  + 'e.g. https://figma.com/design/abc123/Screen-A https://figma.com/design/def456/Screen-B:';

export function extractFigmaLinks(text: string): string[] {
  return Array.from(text.matchAll(FIGMA_LINK_PATTERN), m => m[0]);
}

export async function searchFigmaLinksForTicket(
  ticketContent: string, allowPrompt: boolean
): Promise<string[]> {
  const links = extractFigmaLinks(ticketContent);
  if (links.length) return links;
  if (!allowPrompt || !(process.stdin.isTTY && process.stdout.isTTY)) return [];
  const { input } = await inquirer.prompt<{ input: string }>([
    { type: 'input', name: 'input', message: FIGMA_LINK_PROMPT_MESSAGE },
  ]);
  return extractFigmaLinks(input);
}

/**
 * Resolve Figma links for a plan artifact after AI generation completes.
 *
 * Returns `autoLinks` immediately when non-empty (fast path, no I/O). Otherwise
 * checks for a design system via `conventions` (if supplied) or by running
 * `detectRepoConventions` against `repoDir`. When no design system is found
 * the function returns `[]` without prompting. When a design system is detected
 * and `allowPrompt` is true and the process is running in a TTY session,
 * `searchFigmaLinksForTicket` shows an inquirer prompt so the caller can supply
 * links that were not embedded inline in the ticket.
 *
 * @param content - Raw ticket or source content (used for the inline-search fallback inside searchFigmaLinksForTicket)
 * @param autoLinks - Links already extracted from `content` before AI generation ran
 * @param options - `allowPrompt` gates the inquirer call; `repoDir` drives convention detection when `conventions`
 *   is absent; `conventions` skips a redundant `detectRepoConventions` call when the caller already has the result
 */
export async function resolvePostParseFigmaLinks(
  content: string,
  autoLinks: string[],
  { allowPrompt, repoDir, conventions }: {
    allowPrompt: boolean;
    repoDir?: string;
    conventions?: { designSystem?: { hasUiEnvironment?: boolean } | null };
  }
): Promise<string[]> {
  if (autoLinks.length) return autoLinks;
  const resolved = conventions ?? detectRepoConventions(repoDir ?? process.cwd());
  if (!resolved.designSystem?.hasUiEnvironment) return autoLinks;
  return searchFigmaLinksForTicket(content, allowPrompt);
}
