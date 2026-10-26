import type { PlanStep } from '../types/ai.types';
import { ValidationError } from '../errors/app.error';

const legacyTextKeys = ['description', 'text', 'title', 'content'] as const;

const readLegacyStepText = (step: Record<string, unknown>): string => {
  const text = legacyTextKeys.map(key => step[key]).find(value => typeof value === 'string');
  return typeof text === 'string' ? text : JSON.stringify(step);
};

const withIntent = (description: string, intent: unknown): PlanStep =>
  typeof intent === 'string' ? { description, intent } : { description };

const toPlanStep = (step: unknown, legacyIntent: unknown): PlanStep => {
  if (typeof step === 'string') return withIntent(step, legacyIntent);
  if (step && typeof step === 'object') {
    const record = step as Record<string, unknown>;
    return withIntent(readLegacyStepText(record), record.intent ?? legacyIntent);
  }
  return withIntent(String(step), legacyIntent);
};

export const hasAlignedLegacyStepIntents = (steps: unknown, stepIntents: unknown): boolean =>
  !Array.isArray(stepIntents) || (Array.isArray(steps) && stepIntents.length === steps.length);

export const combineLegacyPlanSteps = (steps: unknown, stepIntents?: unknown): PlanStep[] => {
  if (!Array.isArray(steps)) return [];
  if (!hasAlignedLegacyStepIntents(steps, stepIntents)) {
    throw new ValidationError(
      `Plan has ${(stepIntents as unknown[]).length} stepIntents for ${steps.length} steps`
    );
  }
  const intents = Array.isArray(stepIntents) ? stepIntents : [];
  return steps.map((step, index) => toPlanStep(step, intents[index]));
};

export const coerceLegacyPlanShape = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.steps) || !hasAlignedLegacyStepIntents(record.steps, record.stepIntents)) return raw;
  const { stepIntents, ...rest } = record;
  return { ...rest, steps: combineLegacyPlanSteps(record.steps, stepIntents) };
};

export const planStepDescriptions = (steps: PlanStep[]): string[] => steps.map(step => step.description);
