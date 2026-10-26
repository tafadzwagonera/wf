/**
 * Manual Test: the README Release section is top-level, its TOC links resolve and its yarn scripts exist
 *
 * Run: nr test:manual readme-release-section-consistency.smoke
 *
 * Verifies:
 *   1. exactly one "## Release" heading exists and no "### Release" heading remains
 *   2. the five Release subsections are "###" headings inside the Release section
 *   3. no "####" heading remains inside the Release section
 *   4. every Table of Contents link for Release and its subsections matches a heading slug
 *   5. every `yarn <script>` in a code span or fence of the Release section exists in package.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRoot } from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const releaseSubsections = [
  'Install a released binary',
  'Test the install locally',
  'Run the tests',
  'Publish a release',
  'Hold a release candidate before promoting',
];

type Heading = { level: number; text: string; line: number };

const readmeLines = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf-8').split('\n');
const packageScripts = (JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
}).scripts;

const collectHeadings = (): Heading[] => {
  const headings: Heading[] = [];
  let inFence = false;
  for (const [index, line] of readmeLines.entries()) {
    if (line.startsWith('```')) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2].trim(), line: index });
  }
  return headings;
};

const slugify = (text: string): string =>
  text.toLowerCase().replaceAll(/[^\w\s-]/g, '').replaceAll(' ', '-');

const releaseRange = (headings: Heading[]): { start: number; end: number } => {
  const release = headings.find(heading => heading.level === 2 && heading.text === 'Release');
  const next = release && headings.find(heading => heading.level === 2 && heading.line > release.line);
  return { start: release?.line ?? -1, end: next?.line ?? readmeLines.length };
};

const checkHeadingLevels = (headings: Heading[]): void => {
  const topLevelReleases = headings.filter(heading => heading.level === 2 && heading.text === 'Release');
  const nestedReleases = headings.filter(heading => heading.level === 3 && heading.text === 'Release');
  check(topLevelReleases.length === 1 && nestedReleases.length === 0,
    'one "## Release" heading and no "### Release" heading', `## count ${topLevelReleases.length}, ### count ${nestedReleases.length}`);
  const { start, end } = releaseRange(headings);
  const inside = headings.filter(heading => heading.line > start && heading.line < end);
  const hasSubsection = (name: string): boolean =>
    inside.some(heading => heading.level === 3 && heading.text === name);
  const missing = releaseSubsections.filter(name => !hasSubsection(name));
  check(missing.length === 0, 'all five Release subsections are ### headings inside the Release section', `missing: ${missing.join(', ')}`);
  const deeper = inside.filter(heading => heading.level >= 4).map(heading => heading.text);
  check(deeper.length === 0, 'no #### heading remains inside the Release section', deeper.join(', '));
};

const tocAnchors = (): string[] =>
  readmeLines
    .filter(line => line.trimStart().startsWith('- [') && line.includes('](#'))
    .map(line => line.slice(line.indexOf('](#') + 3, line.lastIndexOf(')')));

const checkTocLinks = (headings: Heading[]): void => {
  const slugs = new Set(headings.map(heading => slugify(heading.text)));
  const wanted = new Set(['Release', ...releaseSubsections].map(slugify));
  const releaseLinks = tocAnchors().filter(anchor => wanted.has(anchor));
  const unresolved = releaseLinks.filter(anchor => !slugs.has(anchor));
  check(releaseLinks.length === wanted.size && unresolved.length === 0,
    'every Release TOC link matches a heading', `links ${releaseLinks.length}/${wanted.size}, unresolved: ${unresolved.join(', ')}`);
};

const codeTextOf = (sectionLines: string[]): string => {
  const chunks: string[] = [];
  let inFence = false;
  for (const line of sectionLines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
    } else if (inFence) {
      chunks.push(line);
    } else {
      chunks.push(...[...line.matchAll(/`([^`]+)`/g)].map(match => match[1]));
    }
  }
  return chunks.join('\n');
};

const namedYarnScripts = (codeText: string): Set<string> => {
  const tokens = codeText.split(/\s+/);
  const scripts = tokens.flatMap((token, index) => {
    const next = tokens[index + 1] ?? '';
    return token === 'yarn' && /^[a-z][\w:-]*$/.test(next) ? [next] : [];
  });
  return new Set(scripts);
};

const checkYarnScriptsExist = (headings: Heading[]): void => {
  const { start, end } = releaseRange(headings);
  const named = namedYarnScripts(codeTextOf(readmeLines.slice(start, end)));
  const missing = [...named].filter(script => !(script in packageScripts));
  check(named.size > 0 && missing.length === 0,
    `every yarn script named in the Release section exists (${[...named].join(', ')})`, `missing: ${missing.join(', ')}`);
};

const main = (): void => {
  console.log('\n README Release section\n');
  const headings = collectHeadings();
  checkHeadingLevels(headings);
  checkTocLinks(headings);
  checkYarnScriptsExist(headings);
  summarise(counts);
};

main();
