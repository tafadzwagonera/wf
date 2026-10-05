import { CommandHelpEntry } from './help-catalog-parser';

export const ISSUE_COMMAND_DOC_NAMES = [
  'issue:fetch',
  'issue:plan',
  'issue:review',
  'issue:create',
  'issue:generate',
  'issue:commit',
  'issue:pr',
  'issue:implement',
] as const;

const generatedBlockStart = (commandName: string): string => `<!-- BEGIN GENERATED COMMAND DOCS: ${commandName} -->`;
const generatedBlockEnd = (commandName: string): string => `<!-- END GENERATED COMMAND DOCS: ${commandName} -->`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renderExamples = (entry: CommandHelpEntry): string => {
  if (!entry.examples?.length) {
    return '';
  }

  const lines = ['```bash'];

  for (const example of entry.examples) {
    if (example.comment) lines.push(`# ${example.comment}`);
    lines.push(example.command, '');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }

  lines.push('```');
  return lines.join('\n');
};

const renderOptions = (entry: CommandHelpEntry): string => {
  if (!entry.options?.length) {
    return '';
  }

  const lines = ['**Options:**', '', '| Flag | Description |', '| ---- | ----------- |'];

  for (const option of entry.options) {
    lines.push(`| \`${option.flags}\` | ${option.description.replaceAll('|', '\\|')} |`);
  }

  return lines.join('\n');
};

export const renderGeneratedCommandDocs = (commandName: string, entry: CommandHelpEntry): string => {
  const sections = [entry.description, renderExamples(entry), renderOptions(entry)]
    .filter(section => section.length > 0)
    .join('\n\n');

  return [generatedBlockStart(commandName), sections, generatedBlockEnd(commandName)].join('\n');
};

const getHeadingLine = (entry: CommandHelpEntry): string => `#### \`${entry.usage.replace(/ \[options\]$/, '')}\``;

const insertGeneratedBlockAfterHeading = (
  readmeContent: string,
  entry: CommandHelpEntry,
  generatedBlock: string
): string => {
  const heading = getHeadingLine(entry);
  const headingIndex = readmeContent.indexOf(heading);
  if (headingIndex === -1) return readmeContent;

  const insertIndex = headingIndex + heading.length;
  return `${readmeContent.slice(0, insertIndex)}\n\n${generatedBlock}${readmeContent.slice(insertIndex)}`;
};

const applyGeneratedBlockForCommand = (
  readmeContent: string,
  commandName: string,
  entry: CommandHelpEntry
): string => {
  const generatedBlock = renderGeneratedCommandDocs(commandName, entry);
  const blockPattern = new RegExp(
    `${escapeRegExp(generatedBlockStart(commandName))}[\\s\\S]*?${escapeRegExp(generatedBlockEnd(commandName))}`
  );

  return blockPattern.test(readmeContent)
    ? readmeContent.replace(blockPattern, generatedBlock)
    : insertGeneratedBlockAfterHeading(readmeContent, entry, generatedBlock);
};

export const synchronizeReadmeCommandDocs = (
  readmeContent: string,
  catalog: Record<string, CommandHelpEntry>
): string => {
  let updatedReadme = readmeContent;

  for (const commandName of ISSUE_COMMAND_DOC_NAMES) {
    const entry = catalog[commandName];
    if (!entry) continue;
    updatedReadme = applyGeneratedBlockForCommand(updatedReadme, commandName, entry);
  }

  return updatedReadme;
};

export const hasReadmeCommandDocDrift = (readmeContent: string, catalog: Record<string, CommandHelpEntry>): boolean =>
  synchronizeReadmeCommandDocs(readmeContent, catalog) !== readmeContent;
