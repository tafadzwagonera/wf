const anthropicPricing: Array<{ prefix: string; inputPerMTok: number; outputPerMTok: number }> = [
  { prefix: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5 },
  { prefix: 'claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10 },
  { prefix: 'claude-sonnet-4', inputPerMTok: 3, outputPerMTok: 15 },
  { prefix: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25 },
];

type OpenAiModelPricing = { inputPerMToken: number; outputPerMToken: number };

const openaiPricing: Record<string, OpenAiModelPricing> = {
  'gpt-4.1': { inputPerMToken: 2, outputPerMToken: 8 },
  'gpt-4.1-mini': { inputPerMToken: 0.4, outputPerMToken: 1.6 },
  'gpt-4.1-nano': { inputPerMToken: 0.1, outputPerMToken: 0.4 },
  'o4-mini': { inputPerMToken: 1.1, outputPerMToken: 4.4 },
  'gpt-4o': { inputPerMToken: 2.5, outputPerMToken: 10 },
  'gpt-4o-mini': { inputPerMToken: 0.15, outputPerMToken: 0.6 },
  'gpt-5-mini': { inputPerMToken: 0.25, outputPerMToken: 2 },
  'gpt-5.1-codex-mini': { inputPerMToken: 0.25, outputPerMToken: 2 },
};

const estimateOpenAiCost = (model: string, inputTokens: number, outputTokens: number): number | null => {
  const pricing = openaiPricing[model];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPerMToken
    + (outputTokens / 1_000_000) * pricing.outputPerMToken;
};

/**
 * Estimates the USD cost of an LLM call from provider, model, and token counts.
 * Returns null when inputs are missing, the provider is unsupported, or the model is unrecognised.
 */
export const estimateLlmCostUsd = (
  provider: string | undefined,
  model: string | undefined,
  usage: { inputTokens: number; outputTokens: number } | undefined,
): number | null => {
  if (!provider || !model || !usage) return null;
  if (provider === 'openai') return estimateOpenAiCost(model, usage.inputTokens, usage.outputTokens);
  if (provider !== 'anthropic') return null;
  const entry = anthropicPricing.find(p => model.startsWith(p.prefix));
  if (!entry) return null;
  return (usage.inputTokens / 1_000_000) * entry.inputPerMTok
    + (usage.outputTokens / 1_000_000) * entry.outputPerMTok;
};
