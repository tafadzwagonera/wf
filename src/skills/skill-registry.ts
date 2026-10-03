import inquirer from 'inquirer';
import { ConfigurationError, ValidationError } from '../shared/errors/app.error';
import type { SkillDefinition, SkillQualityRule, SkillStage } from './skill.types';

export const knownSkills = new Map<string, SkillDefinition>();

export const registerSkill = (skill: SkillDefinition): void => {
  if (knownSkills.has(skill.id)) {
    throw new ValidationError(`Skill "${skill.id}" is already registered.`, { skillId: skill.id });
  }
  knownSkills.set(skill.id, skill);
};

const throwStageMismatchError = (id: string, skillStages: SkillStage[], requestedStage: SkillStage): never => {
  throw new ConfigurationError(
    `Skill "${id}" does not support the "${requestedStage}" stage (supports: ${skillStages.join(', ')}).`
  );
};

const throwUnknownSkillError = (id: string): never => {
  const available = Array.from(knownSkills.keys());
  const list = available.length > 0 ? available.join(', ') : '(none registered)';
  throw new ConfigurationError(`Unknown skill "${id}". Available skills: ${list}.`);
};

const resolveUnknownSkillInteractively = async (id: string): Promise<SkillDefinition | null> => {
  const SKIP_CHOICE = 'Skip (no skill)';
  const { correctedId } = await inquirer.prompt<{ correctedId: string }>([{
    type: 'list', name: 'correctedId',
    message: `Unknown skill "${id}". Select a replacement or skip:`,
    choices: [...Array.from(knownSkills.keys()), SKIP_CHOICE], prefix: ' ',
  }]);
  return correctedId === SKIP_CHOICE ? null : knownSkills.get(correctedId) ?? null;
};

type ResolveSkillsOpts = { interactive: boolean; stage?: SkillStage };

export const resolveSkills = async (ids: string[], opts: ResolveSkillsOpts): Promise<SkillDefinition[]> => {
  const resolved: SkillDefinition[] = [];
  for (const id of ids) {
    const known = knownSkills.get(id);
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

export const collectQualityRules = (skills: SkillDefinition[]): SkillQualityRule[] =>
  skills.flatMap(skill => skill.getQualityRules?.() ?? []);
