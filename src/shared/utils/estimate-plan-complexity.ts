import type { PlanComplexity, PlanModelOutput } from '../types/ai.types';

type EstimablePlan = Pick<PlanModelOutput, 'steps' | 'affectedFiles' | 'phases' | 'newRepositories' | 'risks'>;

const complexityRank: Record<PlanComplexity, number> = { low: 0, medium: 1, high: 2 };

const maxComplexity = (a: PlanComplexity, b: PlanComplexity): PlanComplexity =>
  complexityRank[a] >= complexityRank[b] ? a : b;

const estimateSizeTier = (plan: EstimablePlan): PlanComplexity => {
  const targetedWrites = plan.affectedFiles?.length ?? 0;
  if (targetedWrites > 10 || (plan.phases?.length ?? 0) > 0 || (plan.newRepositories?.length ?? 0) > 0) {
    return 'high';
  }
  return targetedWrites <= 2 && plan.steps.length <= 5 ? 'low' : 'medium';
};

const estimateRiskTier = (plan: EstimablePlan): PlanComplexity =>
  (plan.risks ?? []).reduce<PlanComplexity>((tier, risk) => maxComplexity(tier, risk.severity), 'low');

export const estimatePlanComplexity = (plan: EstimablePlan): PlanComplexity =>
  maxComplexity(estimateSizeTier(plan), estimateRiskTier(plan));
