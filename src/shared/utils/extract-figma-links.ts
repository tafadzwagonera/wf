import inquirer from 'inquirer';

const FIGMA_LINK_PATTERN = /https?:\/\/(www\.)?figma\.com\/(file|design)\/[\w-]+(?:\/[^\s?#]*)*/g;

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
