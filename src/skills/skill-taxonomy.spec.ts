import * as fs from 'fs';
import * as path from 'path';
import './index';
import { knownSkills } from './skill-registry';
import { skillTaxonomy } from './skill-taxonomy';

const contentDir = path.join(__dirname, 'content');
const taxonomyEntries = Object.entries(skillTaxonomy);

describe('skillTaxonomy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(taxonomyEntries.map(([id]) => id))('has a readable SKILL.md for %s', async id => {
    await expect(fs.promises.access(path.join(contentDir, id, 'SKILL.md'), fs.constants.R_OK)).resolves.toBeUndefined();
  });

  it('has a taxonomy entry for every content directory', () => {
    const contentIds = fs
      .readdirSync(contentDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    const orphanIds = contentIds.filter(id => skillTaxonomy[id] === undefined);
    expect(orphanIds).toEqual([]);
  });

  it.each(taxonomyEntries)('keeps headless flag aligned with the registry for %s', (id, audience) => {
    expect(audience.headless).toBe(knownSkills.has(id));
  });

  it.each(taxonomyEntries.map(([id]) => id))('has frontmatter name matching directory for %s', id => {
    const content = fs.readFileSync(path.join(contentDir, id, 'SKILL.md'), 'utf8');
    expect(content).toMatch(new RegExp(`^---\\n(?:[^\\n]*\\n)*?name: ${id}\\n`));
  });

  it.each(taxonomyEntries)('declares at least one audience for %s', (_id, audience) => {
    expect(audience.headless || audience.interactive.length > 0).toBe(true);
  });
});
