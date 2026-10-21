#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { getCommandHelpCatalog } from '../src/bootstrap/help-catalog-parser';
import {
  hasReadmeCommandDocDrift,
  synchronizeReadmeCommandDocs,
} from '../src/bootstrap/issue-command-docs';

const repoRoot = path.join(__dirname, '..');
const readmePath = path.join(repoRoot, 'README.md');
const commandsDir = path.join(repoRoot, 'src', 'commands');
const checkOnly = process.argv.includes('--check');

const readmeContent = fs.readFileSync(readmePath, 'utf8');
const catalog = getCommandHelpCatalog(commandsDir);
const nextReadmeContent = synchronizeReadmeCommandDocs(readmeContent, catalog);

if (checkOnly) {
  if (hasReadmeCommandDocDrift(readmeContent, catalog)) {
    console.error(
      'README command docs are stale. Run `yarn sync:docs` and commit the changes.',
    );
    process.exit(1);
  }

  console.log('README command docs are in sync.');
  process.exit(0);
}

if (nextReadmeContent !== readmeContent) {
  fs.writeFileSync(readmePath, nextReadmeContent, 'utf8');
  console.log(`Synchronized issue command docs in ${readmePath}`);
} else {
  console.log('README command docs already up to date.');
}
