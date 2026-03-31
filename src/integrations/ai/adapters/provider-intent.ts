import type {
  WfAiProviderConfig,
  WfAiProviderName,
} from '../../../config/public-config';

/**
 * Returns whether a provider entry in normalized wf config clearly indicates
 * that the provider is intended for use and should warn when context files are
 * missing.
 *
 * @param providers - Normalized provider entries from config
 * @param providerName - Provider to inspect
 * @returns True when the matching provider has both apiKey and model
 */
export const hasProviderUsageIntent = (
  providers: WfAiProviderConfig[] | undefined,
  providerName: WfAiProviderName,
): boolean => {
  const matchingProvider = providers?.find(
    (provider) => provider.provider === providerName,
  );

  return Boolean(matchingProvider?.apiKey && matchingProvider?.model);
};
