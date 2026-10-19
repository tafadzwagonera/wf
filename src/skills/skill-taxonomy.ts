import type { SkillAudience } from './skill.types';

export const skillTaxonomy: Record<string, SkillAudience> = {
  'coding-style': { interactive: ['claude', 'codex'], headless: true },
  commit: { interactive: ['claude', 'codex'], headless: false },
  lint: { interactive: ['claude', 'codex'], headless: false },
  plan: { interactive: ['claude', 'codex'], headless: false },
  verify: { interactive: ['claude', 'codex'], headless: false },
  'figma-implement': { interactive: ['claude'], headless: false },
  'figma-design-check': { interactive: ['claude'], headless: false },
  'test-driven-development': { interactive: ['claude', 'codex'], headless: true },
  'writing-plans': { interactive: ['claude', 'codex'], headless: true },
  'frontend-design-nuxt': { interactive: ['claude', 'codex'], headless: true },
};
