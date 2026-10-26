import type { PlanStep } from '../types/ai.types';

const legacyTextKeys = ['description', 'text', 'title', 'content'] as const;

const readLegacyStepText = (step: Record<string, unknown>): string => {
  const text = legacyTextKeys.map(key => step[key]).find(value => typeof value === 'string');
  return typeof text === 'string' ? text : JSON.stringify(step);
};

const toPlanStep = (step: unknown): PlanStep => {
  if (typeof step === 'string') return { description: step };
  if (step && typeof step === 'object') {
    const record = step as Record<string, unknown>;
    const description = readLegacyStepText(record);
    return typeof record.intent === 'string' ? { description, intent: record.intent } : { description };
  }
  return { description: String(step) };
};

export const combineLegacyPlanSteps = (steps: unknown): PlanStep[] =>
  Array.isArray(steps) ? steps.map(toPlanStep) : [];

export const coerceLegacyPlanShape = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.steps) || 'stepIntents' in record) return raw;
  return { ...record, steps: combineLegacyPlanSteps(record.steps) };
};

export const planStepDescriptions = (steps: PlanStep[]): string[] => steps.map(step => step.description);
