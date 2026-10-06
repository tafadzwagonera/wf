#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertLinkable, syncLink } from '../src/skills/skill-link';
import type { SyncStatus } from '../src/skills/skill-link';
import { skillTaxonomy } from '../src/skills/skill-taxonomy';
import type { InteractiveCli } from '../src/skills/skill.types';

interface LinkPlan {
  cli: InteractiveCli;
  id: string;
  source: string;
  destination: string;
}

const repoRoot = path.resolve(__dirname, '..');
const contentDir = path.join(repoRoot, 'src', 'skills', 'content');

const skillsParentDir = (cli: InteractiveCli): string => path.join(os.homedir(), `.${cli}`, 'skills');

const assertSkillsParentExists = (cli: InteractiveCli): void => {
  const parent = skillsParentDir(cli);
  if (fs.existsSync(parent)) return;
  throw new Error(`${parent} does not exist. ${cli} does not appear to be installed or initialized on this machine.`);
};

const resolveClis = (): InteractiveCli[] =>
  [...new Set(Object.values(skillTaxonomy).flatMap(audience => audience.interactive))];

const buildLinkPlans = (): LinkPlan[] =>
  Object.entries(skillTaxonomy).flatMap(([id, audience]) =>
    audience.interactive.map(cli => ({
      cli,
      id,
      source: path.join(contentDir, id),
      destination: path.join(skillsParentDir(cli), id),
    })));

const main = async (): Promise<void> => {
  for (const cli of resolveClis()) assertSkillsParentExists(cli);
  const plans = buildLinkPlans();
  for (const plan of plans) await assertLinkable(plan);

  const counts: Record<SyncStatus, number> = { linked: 0, relinked: 0, ok: 0 };
  for (const plan of plans) {
    const status = await syncLink(plan);
    counts[status] += 1;
    console.log(`${status} ${plan.cli}/${plan.id}`);
  }
  console.log(`linked ${counts.linked}, relinked ${counts.relinked}, ok ${counts.ok}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
