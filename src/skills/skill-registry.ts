import inquirer from 'inquirer';
import { ConfigurationError } from '../shared/errors/app.error';
import type { SkillDefinition, SkillQualityRule, SkillStage } from './skill.types';

export const KNOWN_SKILLS = new Map<string, SkillDefinition>();

/**
 * Register a skill definition. Throws if a skill with the same ID is already registered.
 *
 * @param skill - The skill definition to register
 */
export const registerSkill = (skill: SkillDefinition): void => {
  if (KNOWN_SKILLS.has(skill.id)) {
    throw new Error(`Skill "${skill.id}" is already registered.`);
  }
  KNOWN_SKILLS.set(skill.id, skill);
};

const throwStageMismatchError = (id: string, skillStages: SkillStage[], requestedStage: SkillStage): never => {
  throw new ConfigurationError(
    `Skill "${id}" does not support the "${requestedStage}" stage (supports: ${skillStages.join(', ')}).`
  );
};

const throwUnknownSkillError = (id: string): never => {
  const available = Array.from(KNOWN_SKILLS.keys());
  const list = available.length > 0 ? available.join(', ') : '(none registered)';
  throw new ConfigurationError(`Unknown skill "${id}". Available skills: ${list}.`);
};

const resolveUnknownSkillInteractively = async (id: string): Promise<SkillDefinition | null> => {
  const SKIP_CHOICE = 'Skip (no skill)';
  const { correctedId } = await inquirer.prompt<{ correctedId: string }>([{
    type: 'list', name: 'correctedId',
    message: `Unknown skill "${id}". Select a replacement or skip:`,
    choices: [...Array.from(KNOWN_SKILLS.keys()), SKIP_CHOICE], prefix: ' ',
  }]);
  return correctedId === SKIP_CHOICE ? null : KNOWN_SKILLS.get(correctedId) ?? null;
};

type ResolveSkillsOpts = { interactive: boolean; stage?: SkillStage };

/**
 * Resolve skill IDs to definitions. Unknown IDs are handled based on the interactive flag.
 * Interactive: prompts via inquirer to correct or skip unknown IDs.
 * Non-interactive: throws ConfigurationError listing the unknown ID and available skills.
 * When stage is provided, rejects skills that do not support the given stage.
 *
 * @param ids - Skill IDs declared in config
 * @param opts - Options with interactive flag and optional stage filter
 * @returns Resolved skill definitions
 */
export const resolveSkills = async (ids: string[], opts: ResolveSkillsOpts): Promise<SkillDefinition[]> => {
  const resolved: SkillDefinition[] = [];
  for (const id of ids) {
    const known = KNOWN_SKILLS.get(id);
    if (known) {
      if (opts.stage && !known.stages.includes(opts.stage)) throwStageMismatchError(id, known.stages, opts.stage);
      resolved.push(known);
      continue;
    }
    if (!opts.interactive) throwUnknownSkillError(id);
    const corrected = await resolveUnknownSkillInteractively(id);
    if (corrected) resolved.push(corrected);
  }
  return resolved;
};

/**
 * Collect quality rules from skill definitions that provide them.
 *
 * @param skills - Resolved skill definitions
 * @returns Merged list of quality rules
 */
export const collectQualityRules = (skills: SkillDefinition[]): SkillQualityRule[] =>
  skills.flatMap(skill => skill.getQualityRules?.() ?? []);
