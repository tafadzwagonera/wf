export interface ModelProviderMismatch {
  prefix: string;
  expectedProvider: string;
}

const providerByModelPrefix: Record<string, string> = {
  'claude-': 'anthropic',
  'gpt-': 'openai',
  'o1-': 'openai',
  'o3-': 'openai',
  'o4-': 'openai',
  'gemini-': 'google',
  'deepseek-': 'deepseek',
};

/**
 * Reports the first well-known model prefix (e.g. `gpt-`) that belongs to a different provider than the one given.
 * Returns null when the pair is consistent or the model prefix is not in the lookup table.
 */
export const findModelProviderMismatch = (provider: string, model: string): ModelProviderMismatch | null => {
  const match = Object.entries(providerByModelPrefix).find(
    ([prefix, expectedProvider]) => model.startsWith(prefix) && provider !== expectedProvider,
  );
  return match ? { prefix: match[0], expectedProvider: match[1] } : null;
};
