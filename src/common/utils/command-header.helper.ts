import { COMMAND_DOCS } from '../docs/command-docs.registry';
import { renderExamplesSection } from './cli-help-render';

/**
 * Print a command's runtime header: its summary line, a blank line, then a 5-capped
 * `Examples:` section, sharing the same renderer as `-h`. Reads only the hand-authored
 * registry — never the build-time catalog — so a missing `dist/` artifact cannot break it.
 *
 * @param commandName - Registry key for the running command (a compile-time-checked name)
 */
export function printCommandHeader(commandName: keyof typeof COMMAND_DOCS): void {
  const docs = COMMAND_DOCS[commandName];
  console.log(docs.summary);
  console.log('');
  console.log(renderExamplesSection(docs.examples, 5).join('\n'));
}
