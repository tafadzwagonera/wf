import * as fs from 'node:fs';
import * as path from 'node:path';

const contentDir = path.join(__dirname, 'content');
const seaConfigPath = path.join(__dirname, '..', '..', 'scripts', 'sea', 'sea-config.json');

describe('SEA asset map', () => {
  const seaConfig = JSON.parse(fs.readFileSync(seaConfigPath, 'utf8')) as { assets: Record<string, string> };
  const skillIds = fs.readdirSync(contentDir).filter(id => fs.existsSync(path.join(contentDir, id, 'SKILL.md')));

  it.each(skillIds)('embeds skills/%s/SKILL.md from its source file', skillId => {
    expect(seaConfig.assets[`skills/${skillId}/SKILL.md`]).toBe(`src/skills/content/${skillId}/SKILL.md`);
  });

  it('lists no skill that has no SKILL.md source', () => {
    const embeddedIds = Object.keys(seaConfig.assets)
      .filter(key => key.startsWith('skills/'))
      .map(key => key.split('/')[1]);

    expect(embeddedIds.filter(id => !skillIds.includes(id))).toEqual([]);
  });
});
