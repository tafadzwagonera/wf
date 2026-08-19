import chalk from 'chalk';
import { formatCliCommandTokens } from './cli-command-colors';
import type { CommandHelpExample } from '../types/bootstrap.types';

export const MAX_HELP_WIDTH = 80;

const ANSI_ESCAPE = String.fromCodePoint(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');
const MOCK_STYLE_TAG_PATTERN = /<\/?(?:cyan|yellow|green|gray|bold-cyan)>/g;

export const getVisibleLength = (value: string): number =>
  value.replace(ANSI_PATTERN, '').replace(MOCK_STYLE_TAG_PATTERN, '').length;

function findPreferredSplitIndex(candidate: string, maxTokenWidth: number): number {
  const splitMatches = Array.from(candidate.matchAll(/[/?&=_-]/g));
  return splitMatches.length > 0 ? (splitMatches.at(-1)?.index ?? 0) + 1 : maxTokenWidth;
}

function splitPlainLongToken(token: string, maxTokenWidth: number): string[] {
  if (token.length <= maxTokenWidth) return [token];
  const chunks: string[] = [];
  let remaining = token;
  while (remaining.length > maxTokenWidth) {
    const splitIndex = findPreferredSplitIndex(remaining.slice(0, maxTokenWidth), maxTokenWidth);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

const expandLongTokensForWrapping = (tokens: string[], maxTokenWidth: number): string[] =>
  tokens.flatMap(token => {
    if (getVisibleLength(token) <= maxTokenWidth) {
      return [token];
    }

    if (ANSI_PATTERN.test(token) || MOCK_STYLE_TAG_PATTERN.test(token)) {
      ANSI_PATTERN.lastIndex = 0;
      MOCK_STYLE_TAG_PATTERN.lastIndex = 0;
      return [token];
    }

    ANSI_PATTERN.lastIndex = 0;
    MOCK_STYLE_TAG_PATTERN.lastIndex = 0;
    return splitPlainLongToken(token, maxTokenWidth);
  });

export function buildWrappedLines(tokens: string[], initialIndent: string, subsequentIndent: string): string[] {
  const lines: string[] = [];
  let currentLine = initialIndent;

  for (const token of tokens) {
    const nextLine = `${currentLine}${currentLine.trim().length === 0 ? '' : ' '}${token}`;

    if (getVisibleLength(nextLine) <= MAX_HELP_WIDTH || currentLine === initialIndent) {
      currentLine = nextLine;
      continue;
    }

    lines.push(currentLine);
    currentLine = `${subsequentIndent}${token}`;
  }

  lines.push(currentLine);
  return lines;
}

export function wrapStyledTokens(tokens: string[], initialIndent = '', subsequentIndent = initialIndent): string[] {
  const normalizedTokens = expandLongTokensForWrapping(
    tokens,
    MAX_HELP_WIDTH - Math.max(getVisibleLength(initialIndent), getVisibleLength(subsequentIndent))
  );

  if (normalizedTokens.length === 0) {
    return [initialIndent.trimEnd()];
  }

  return buildWrappedLines(normalizedTokens, initialIndent, subsequentIndent);
}

function renderExampleCommentLines(comment: string): string[] {
  const words = comment.split(/\s+/).filter(word => word.length > 0);
  return buildWrappedLines(words, '  #', '    ').map(line => chalk.gray(line));
}

/**
 * Render a capped `Examples:` section, wrapping each command to MAX_HELP_WIDTH and
 * prefixing it with its authored comment (if any) as a dim, word-wrapped line.
 *
 * @param examples - Example entries to render
 * @param limit - Maximum number of examples to include; omit to render all
 * @returns Rendered lines, starting with the `Examples:` heading
 */
export function renderExamplesSection(examples: CommandHelpExample[], limit?: number): string[] {
  const capped = limit === undefined ? examples : examples.slice(0, limit);
  return [
    chalk.bold.cyan('Examples:'),
    ...capped.flatMap(example => [
      ...(example.comment ? renderExampleCommentLines(example.comment) : []),
      ...wrapStyledTokens(formatCliCommandTokens(example.command), '  ', '  '),
    ]),
  ];
}
