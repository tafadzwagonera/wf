import * as fs from 'fs';
import * as path from 'path';
import type { CommandHelpEntry, CommandHelpOption, CommandHelpExample } from '../shared/types/bootstrap.types';

export type { CommandHelpEntry, CommandHelpOption, CommandHelpExample };

const STRING_LITERAL_PATTERN = /'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|`((?:\\.|[^`])*)`/g;

const unquoteStringLiteral = (value: string): string =>
  value
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\`/g, '`')
    .replace(/\\n/g, '\n');

const evaluateStringExpression = (expression?: string): string | undefined => {
  if (!expression) return undefined;

  const parts = Array.from(expression.matchAll(STRING_LITERAL_PATTERN)).map(match => unquoteStringLiteral(match[0]));

  return parts.length > 0 ? parts.join('') : undefined;
};

const findMatchingBrace = (source: string, startIndex: number): number => {
  let depth = 0;
  let activeQuote: "'" | '"' | '`' | null = null;
  let isEscaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (activeQuote) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      activeQuote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
};

const extractDecoratorBlocks = (source: string, decoratorName: 'Command' | 'Option' | 'SubCommand'): string[] => {
  const blocks: string[] = [];
  const marker = `@${decoratorName}({`;
  let searchIndex = 0;

  while (searchIndex < source.length) {
    const markerIndex = source.indexOf(marker, searchIndex);
    if (markerIndex === -1) {
      break;
    }

    const objectStart = source.indexOf('{', markerIndex);
    if (objectStart === -1) {
      break;
    }

    const objectEnd = findMatchingBrace(source, objectStart);
    if (objectEnd === -1) {
      break;
    }

    blocks.push(source.slice(objectStart + 1, objectEnd));
    searchIndex = objectEnd + 1;
  }

  return blocks;
};

const splitTopLevelSegments = (block: string): string[] => {
  const segments: string[] = [];
  let currentSegment = '';
  let depth = 0;
  let activeQuote: "'" | '"' | '`' | null = null;
  let isEscaped = false;

  for (const char of block) {
    if (activeQuote) {
      currentSegment += char;

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      activeQuote = char;
      currentSegment += char;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      currentSegment += char;
      continue;
    }

    if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      currentSegment += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (currentSegment.trim().length > 0) {
        segments.push(currentSegment.trim());
      }
      currentSegment = '';
      continue;
    }

    currentSegment += char;
  }

  if (currentSegment.trim().length > 0) {
    segments.push(currentSegment.trim());
  }

  return segments;
};

const parseObjectProperties = (block: string): Map<string, string> => {
  const properties = new Map<string, string>();

  for (const segment of splitTopLevelSegments(block)) {
    const separatorIndex = segment.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();
    properties.set(key, value);
  }

  return properties;
};

const extractExamples = (source: string): CommandHelpExample[] => {
  const examplesArrayMatch = source.match(/const\s+\w+_EXAMPLES\s*:\s*CliExample\[\]\s*=\s*\[(.*?)\];/s);
  if (!examplesArrayMatch) {
    return [];
  }

  return Array.from(examplesArrayMatch[1].matchAll(/\{([\s\S]*?)\}/g))
    .map(match => parseObjectProperties(match[1]))
    .map(properties => ({
      comment: evaluateStringExpression(properties.get('comment')),
      command: evaluateStringExpression(properties.get('command')),
    }))
    .filter(
      (
        example
      ): example is {
        comment: string | undefined;
        command: string;
      } => Boolean(example.command)
    )
    .map(example =>
      example.comment ? { comment: example.comment, command: example.command } : { command: example.command }
    );
};

const formatFlagForHelp = (flagsExpression?: string): string | undefined => {
  const flags = evaluateStringExpression(flagsExpression);
  if (!flags) return undefined;

  return flags.trim();
};

const buildUsage = ({
  commandName,
  argumentsValue,
  hasOptions,
  subcommandNames,
}: {
  commandName: string;
  argumentsValue?: string;
  hasOptions: boolean;
  subcommandNames: string[];
}): string => {
  if (subcommandNames.length > 0) {
    return `wf ${commandName} <${subcommandNames.join('|')}> [args]`;
  }

  const argumentSection = argumentsValue ? ` ${argumentsValue}` : '';
  const optionsSection = hasOptions ? ' [options]' : '';

  return `wf ${commandName}${argumentSection}${optionsSection}`;
};

/**
 * Parse TypeScript command source files in `commandsDir` and build a help catalog.
 *
 * @param commandsDir - Absolute path to the directory containing command `.ts` source files
 * @returns A map of command name to its help entry
 */
export const getCommandHelpCatalog = (commandsDir: string): Record<string, CommandHelpEntry> => {
  const catalog: Record<string, CommandHelpEntry> = {};
  const commandFiles = fs
    .readdirSync(commandsDir)
    .filter(fileName => fileName.endsWith('.ts') && !fileName.endsWith('.spec.ts'))
    .sort();

  for (const fileName of commandFiles) {
    const source = fs.readFileSync(path.join(commandsDir, fileName), 'utf8');
    const commandBlock = extractDecoratorBlocks(source, 'Command')[0];

    if (!commandBlock) {
      continue;
    }

    const commandProperties = parseObjectProperties(commandBlock);
    const commandName = evaluateStringExpression(commandProperties.get('name'));
    const description = evaluateStringExpression(commandProperties.get('description'));

    if (!commandName || !description) {
      continue;
    }

    const subcommandNames = extractDecoratorBlocks(source, 'SubCommand')
      .map(block => parseObjectProperties(block))
      .map(properties => evaluateStringExpression(properties.get('name')))
      .filter((name): name is string => Boolean(name));

    const options = extractDecoratorBlocks(source, 'Option')
      .map(block => parseObjectProperties(block))
      .map(properties => ({
        flags: formatFlagForHelp(properties.get('flags')),
        description: evaluateStringExpression(properties.get('description')),
      }))
      .filter((option): option is CommandHelpOption => Boolean(option.flags && option.description));

    const examples = extractExamples(source);

    catalog[commandName] = {
      description,
      usage: buildUsage({
        commandName,
        argumentsValue: evaluateStringExpression(commandProperties.get('arguments')),
        hasOptions: options.length > 0,
        subcommandNames,
      }),
      options: options.length > 0 ? options : undefined,
      examples: examples.length > 0 ? examples : undefined,
    };
  }

  return catalog;
};
