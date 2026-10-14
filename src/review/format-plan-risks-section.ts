const MAX_LISTED_PLAN_RISKS = 10;
const PLAN_RISKS_HEADING = 'Known plan risks (context only; still report any defect you find)';

export const formatPlanRisksSection = (
  risks: { description: string; severity: string }[] | null | undefined
): string => {
  if (!risks || risks.length === 0) return '';

  const riskLines = risks
    .slice(0, MAX_LISTED_PLAN_RISKS)
    .map(risk => `- [${risk.severity}] ${risk.description}`);

  if (risks.length > MAX_LISTED_PLAN_RISKS) {
    riskLines.push(`- ${risks.length - MAX_LISTED_PLAN_RISKS} more omitted`);
  }

  return PLAN_RISKS_HEADING + '\n' + riskLines.join('\n');
};
