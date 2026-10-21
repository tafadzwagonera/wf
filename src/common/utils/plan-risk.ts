import { planComplexitySchema } from '../schemas/ai.schema';
import type { PlanRisk } from '../types/ai.types';

const SEVERITY_PREFIX_PATTERN = /^\[(low|medium|high)]\s+(.*)$/i;

export const formatPlanRisk = (risk: PlanRisk): string => `[${risk.severity}] ${risk.description}`;

export const formatPlanRisks = (risks: PlanRisk[] | null | undefined): string[] => (risks ?? []).map(formatPlanRisk);

export const parsePlanRiskLine = (line: string): PlanRisk => {
  const match = SEVERITY_PREFIX_PATTERN.exec(line);
  if (!match) {
    return { description: line, severity: 'medium' };
  }
  return { description: match[2], severity: planComplexitySchema.parse(match[1].toLowerCase()) };
};

export const normalizePlanRisk = (value: unknown): PlanRisk => {
  if (typeof value === 'string') {
    return parsePlanRiskLine(value);
  }
  if (value !== null && typeof value === 'object' && 'description' in value) {
    const { description, severity } = value as { description: unknown; severity?: unknown };
    const parsedSeverity = planComplexitySchema.safeParse(severity);
    return {
      description: String(description),
      severity: parsedSeverity.success ? parsedSeverity.data : 'medium',
    };
  }
  return { description: JSON.stringify(value) ?? 'undefined', severity: 'medium' };
};

export const normalizePlanRisks = (value: unknown): PlanRisk[] | undefined =>
  Array.isArray(value) ? value.map(normalizePlanRisk) : undefined;
