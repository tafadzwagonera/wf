import type { ResolutionPlan } from '../shared/types/ai.types';

type SkillStage = 'plan' | 'implement' | 'review';

interface SkillQualityRule {
  ruleId: string;
  validate(plan: Partial<ResolutionPlan>): string[];
}

type InteractiveCli = 'claude' | 'codex';

interface SkillAudience {
  interactive: InteractiveCli[];
  headless: boolean;
}

interface SkillDefinition {
  id: string;
  stages: SkillStage[];
  getQualityRules?(): SkillQualityRule[];
}

export type { SkillStage, SkillQualityRule, SkillDefinition, InteractiveCli, SkillAudience };
