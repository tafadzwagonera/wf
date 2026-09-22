import type { WfAiProviderConfig, WfAiProviderName } from '../../../config/public-config';

/**
 * Determines whether a provider is actively in use — either as the default,
 * as an implicit first-entry default, or via a stage-level override.
 * @param providers - The full list of configured AI providers.
 * @param providerName - The provider name to check.
 * @param stageProviders - Provider names referenced by stage-level overrides.
 * @returns `true` if the provider is active and context config warnings are relevant.
 */
export const hasProviderUsageIntent = (
  providers: WfAiProviderConfig[] | undefined,
  providerName: WfAiProviderName,
  stageProviders: (WfAiProviderName | undefined)[] = [],
): boolean => {
  const matchingProvider = providers?.find(provider => provider.provider === providerName);
  if (!matchingProvider?.apiKey || !matchingProvider?.model) return false;

  const defaultIsReachable = stageProviders.length === 0 || stageProviders.includes(undefined);
  if (matchingProvider.default && defaultIsReachable) return true;

  if (stageProviders.includes(providerName)) return true;

  const hasExplicitDefault = providers?.some(p => p.default);
  return !hasExplicitDefault && providers?.[0]?.provider === providerName;
};

/**
 * Extracts provider names from stage-level configuration overrides.
 * @param stages - The stages configuration object from wf.config.ts.
 * @returns An array of provider names (may include `undefined` for stages without a provider override).
 */
export const extractStageProviders = (
  stages: Record<
    string,
    { provider?: WfAiProviderName } | { verificationConditions?: unknown } | undefined
  > | undefined,
): (WfAiProviderName | undefined)[] => {
  if (!stages) return [];
  return Object.values(stages).map(stage => (stage && 'provider' in stage ? stage.provider : undefined));
};
