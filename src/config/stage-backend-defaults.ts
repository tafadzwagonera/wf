import type { WfBackendMode } from './public-config';

export type StageBackendDefaultStageName = 'plan' | 'implement' | 'review' | 'generate' | 'commit';

const agentDefaultBackendStages = new Set<StageBackendDefaultStageName>([
  'plan',
  'implement',
  'review',
  'generate',
]);

/**
 * Resolve the default backend for a workflow stage when config omits it.
 *
 * @param stageName - Workflow stage name
 * @returns Backend to use for that stage by default
 */
export const resolveDefaultStageBackend = (stageName: StageBackendDefaultStageName): WfBackendMode => {
  if (agentDefaultBackendStages.has(stageName)) {
    return 'agent';
  }

  return 'standard';
};

/**
 * Determine whether a workflow stage supports agent-capable backends.
 *
 * @param stageName - Workflow stage name
 * @returns True when `agent` or `cli` are valid backend values
 */
export const isAgentSupportedStage = (stageName: StageBackendDefaultStageName): boolean =>
  agentDefaultBackendStages.has(stageName);
