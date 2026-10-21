import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandHelpEntry, CommandHelpOption } from '../common/types/bootstrap.types';
import { COMMAND_DOCS } from '../common/docs/command-docs.registry';

export type { CommandHelpEntry, CommandHelpOption, CommandHelpExample } from '../common/types/bootstrap.types';

const STRING_LITERAL_PATTERN = /'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|`((?:\\.|[^`])*)`/g;

const unquoteStringLiteral = (value: string): string =>
  value
    .replaceAll(/(?:^['"`])|(?:['"`]$)/g, '')
    .replaceAll(String.raw`\'`, '\'')
    .replaceAll(String.raw`\"`, '"')
    .replaceAll('\\`', '`')
    .replaceAll(String.raw`\n`, '\n');

const evaluateStringExpression = (expression?: string): string | undefined => {
  if (!expression) return undefined;

  const parts = Array.from(expression.matchAll(STRING_LITERAL_PATTERN)).map(match => unquoteStringLiteral(match[0]));

  return parts.length > 0 ? parts.join('') : undefined;
};

function skipQuotedSection(source: string, startIndex: number, quoteChar: string): number {
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quoteChar) {
      return index;
    }
  }
  return source.length;
}

function findMatchingBrace(source: string, startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\'' || char === '"' || char === '`') {
      index = skipQuotedSection(source, index + 1, char);
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractDecoratorBlocks(source: string, decoratorName: 'Command' | 'Option' | 'SubCommand'): string[] {
  const blocks: string[] = [];
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const markerIndex = source.indexOf(`@${decoratorName}({`, searchIndex);
    if (markerIndex === -1) break;
    const objectStart = source.indexOf('{', markerIndex);
    if (objectStart === -1) break;
    const objectEnd = findMatchingBrace(source, objectStart);
    if (objectEnd === -1) break;
    blocks.push(source.slice(objectStart + 1, objectEnd));
    searchIndex = objectEnd + 1;
  }
  return blocks;
}

function adjustDepthForChar(char: string, depth: number): number {
  if ('{[('.includes(char)) return depth + 1;
  if ('}])'.includes(char)) return depth - 1;
  return depth;
}

function findNextTopLevelComma(block: string, startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < block.length; index += 1) {
    const char = block[index];
    if (char === '\'' || char === '"' || char === '`') {
      index = skipQuotedSection(block, index + 1, char);
    } else if (char === ',' && depth === 0) {
      return index;
    } else {
      depth = adjustDepthForChar(char, depth);
    }
  }
  return -1;
}

function splitTopLevelSegments(block: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let commaIndex = findNextTopLevelComma(block, start);
  while (commaIndex !== -1) {
    const segment = block.slice(start, commaIndex).trim();
    if (segment.length > 0) segments.push(segment);
    start = commaIndex + 1;
    commaIndex = findNextTopLevelComma(block, start);
  }
  const lastSegment = block.slice(start).trim();
  if (lastSegment.length > 0) segments.push(lastSegment);
  return segments;
}

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
const formatFlagForHelp = (flagsExpression?: string): string | undefined => {
  const flags = evaluateStringExpression(flagsExpression);
  if (!flags) return undefined;

  return flags.trim();
};

interface BuildUsageOptions {
  commandName: string;
  argumentsValue?: string;
  hasOptions: boolean;
  subcommandNames: string[];
}

function buildUsage({ commandName, argumentsValue, hasOptions, subcommandNames }: BuildUsageOptions): string {
  if (subcommandNames.length > 0) {
    return `wf ${commandName} <${subcommandNames.join('|')}> [args]`;
  }

  const argumentSection = argumentsValue ? ` ${argumentsValue}` : '';
  const optionsSection = hasOptions ? ' [options]' : '';

  return `wf ${commandName}${argumentSection}${optionsSection}`;
}

function parseSubcommandNames(source: string): string[] {
  return extractDecoratorBlocks(source, 'SubCommand')
    .map(block => parseObjectProperties(block))
    .map(properties => evaluateStringExpression(properties.get('name')))
    .filter((name): name is string => Boolean(name));
}

function parseOptions(source: string): CommandHelpOption[] {
  return extractDecoratorBlocks(source, 'Option')
    .map(block => parseObjectProperties(block))
    .map(properties => ({
      flags: formatFlagForHelp(properties.get('flags')),
      description: evaluateStringExpression(properties.get('description')),
    }))
    .filter((option): option is CommandHelpOption => Boolean(option.flags && option.description))
    .sort((a, b) => {
      const longFlag = (f: string): string => ((/--([a-z][\w-]*)/.exec(f))?.[1] ?? f).toLowerCase();
      return longFlag(a.flags).localeCompare(longFlag(b.flags));
    });
}

function buildCommandEntry(source: string, name: string, description: string, argsExpr?: string): CommandHelpEntry {
  const subcommandNames = parseSubcommandNames(source);
  const options = parseOptions(source);
  const examples = COMMAND_DOCS[name as keyof typeof COMMAND_DOCS]?.examples ?? [];
  const argumentsValue = evaluateStringExpression(argsExpr);
  const usage = buildUsage({ commandName: name, argumentsValue, hasOptions: options.length > 0, subcommandNames });
  const optionalOptions = options.length > 0 ? options : undefined;
  const optionalExamples = examples.length > 0 ? examples : undefined;
  return { description, usage, options: optionalOptions, examples: optionalExamples };
}

function listCommandFiles(commandsDir: string): string[] {
  return fs
    .readdirSync(commandsDir)
    .filter(fileName => fileName.endsWith('.ts') && !fileName.endsWith('.spec.ts'))
    .sort((a, b) => a.localeCompare(b));
}

export function getCommandHelpCatalog(commandsDir: string): Record<string, CommandHelpEntry> {
  const catalog: Record<string, CommandHelpEntry> = {};
  for (const fileName of listCommandFiles(commandsDir)) {
    const source = fs.readFileSync(path.join(commandsDir, fileName), 'utf8');
    const commandBlock = extractDecoratorBlocks(source, 'Command')[0];
    if (!commandBlock) continue;
    const commandProperties = parseObjectProperties(commandBlock);
    const commandName = evaluateStringExpression(commandProperties.get('name'));
    const description = evaluateStringExpression(commandProperties.get('description'));
    if (!commandName || !description) continue;
    catalog[commandName] = buildCommandEntry(source, commandName, description, commandProperties.get('arguments'));
  }
  return catalog;
}
