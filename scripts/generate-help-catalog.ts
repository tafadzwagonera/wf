#!/usr/bin/env ts-node
/**
 * Build-time script: generates dist/bootstrap/commands-help.catalog.json
 * from the TypeScript command source files in src/commands/.
 *
 * Run automatically via the `postbuild` npm script after `nest build`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCommandHelpCatalog } from '../src/bootstrap/help-catalog-parser';

const commandsDir = path.join(__dirname, '..', 'src', 'commands');
const outputPath = path.join(
  __dirname,
  '..',
  'dist',
  'bootstrap',
  'commands-help.catalog.json',
);
const docsSnapshotPath = path.join(
  __dirname,
  '..',
  'docs',
  'commands-help.catalog.json',
);

const catalog = getCommandHelpCatalog(commandsDir);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.mkdirSync(path.dirname(docsSnapshotPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2), 'utf8');
fs.writeFileSync(docsSnapshotPath, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`Help catalog written to ${outputPath}`);
console.log(`Help catalog snapshot written to ${docsSnapshotPath}`);
