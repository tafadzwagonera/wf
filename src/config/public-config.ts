export type WfAiProviderName = 'anthropic' | 'openai' | 'google' | 'deepseek';

export interface WfAiProviderConfig {
  provider: WfAiProviderName;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  default?: boolean;
}

export interface WfAiStageTargetConfig {
  provider: WfAiProviderName;
  model?: string;
  agent?: boolean;
}

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

export interface WfVerificationConditionsConfig {
  policyFile?: string;
  scripts?: Record<string, string>;
}

export interface WfImplementStageModelsConfig {
  default?: string;
  mechanical?: string;
}

export interface WfImplementStageConfig extends WfAiStageTargetConfig {
  models?: WfImplementStageModelsConfig;
  verificationConditions?: WfVerificationConditionsConfig;
}

export interface WfCreateStageConfig {
  provider?: WfAiProviderName;
  model?: string;
  agent?: boolean;
  verificationConditions?: WfVerificationConditionsConfig;
}

export interface WfConfig {
  tracker?: 'jira' | 'github' | 'bitbucket';
  output?: {
    defaultFormat?: 'json' | 'md' | 'yaml' | 'yml';
  };
  ai?: WfAiProviderConfig[];
  atlassian?: WfAtlassianConfig;
  github?: {
    token?: string;
    defaultRepo?: string;
  };
  git?: {
    defaultBranch?: string;
    commitFormat?: 'conventional' | 'freeform' | 'auto';
  };
  branching?: {
    atlassianPattern?: string;
    githubPattern?: string;
    prefixMapping?: {
      implement?: string;
      fix?: string;
      investigate?: string;
    };
  };
  log?: {
    level?: 'error' | 'warn' | 'info' | 'debug';
  };
  logging?: {
    level?: 'error' | 'warn' | 'info' | 'debug';
  };
  app?: {
    nodeEnv?: 'development' | 'production' | 'test';
  };
  slack?: {
    botToken?: string;
    userToken?: string;
  };
  stages?: Partial<
    Record<'plan' | 'review' | 'generate' | 'commit', WfAiStageTargetConfig>
  > & {
    create?: WfCreateStageConfig;
    implement?: WfImplementStageConfig;
    fetch?: string;
  };
}

/**
 * Identity helper for `wf.config.*` authoring with static typing.
 *
 * @param config - Consumer-facing wf configuration object
 * @returns The provided config unchanged
 */
export const defineConfig = (config: WfConfig): WfConfig => config;
