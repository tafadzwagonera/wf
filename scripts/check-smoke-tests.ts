import * as fs from 'node:fs';
import * as path from 'node:path';

const smokeDir = path.resolve(__dirname, '../test/manual');

const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '').trim();

const emptySmokeTests = fs
  .readdirSync(smokeDir)
  .filter(file => file.endsWith('.smoke.ts'))
  .filter(file => stripComments(fs.readFileSync(path.join(smokeDir, file), 'utf-8')) === '');

if (emptySmokeTests.length > 0) {
  console.error(`Smoke tests with no executable code (they would pass without running anything):\n${emptySmokeTests.map(f => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('All smoke tests contain executable code.');
