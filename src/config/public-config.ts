import type { WfConfig } from '../shared/types/config.types';

export type {
  WfAiProviderName,
  WfBackendMode,
  WfAiProviderConfig,
  WfAiStageTargetConfig,
  WfCreateStageConfig,
  WfConfig,
  WfImplementSkillName,
  WfImplementStageConfig,
  WfImplementStageModelRoutingThresholdsConfig,
  WfImplementStageModelsConfig,
  WfPlanSkillName,
  WfPlanStageConfig,
  WfVerificationConditionsConfig,
} from '../shared/types/config.types';

export interface WfAtlassianConfig {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  jira?: {
    apiToken?: string;
    defaultProject?: string;
  };
  bitbucket?: {
    workspace?: string;
    apiToken?: string;
  };
}

/**
 * Identity helper for `wf.config.*` authoring with static typing.
 *
 * @param config - Consumer-facing wf configuration object
 * @returns The provided config unchanged
 */
export const defineConfig = (config: WfConfig): WfConfig => config;
