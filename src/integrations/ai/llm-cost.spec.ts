import { estimateLlmCostUsd } from './llm-cost';

describe('estimateLlmCostUsd', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('null guards', () => {
    it('returns null when provider is undefined', () => {
      expect(estimateLlmCostUsd(undefined, 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 })).toBeNull();
    });

    it('returns null when model is undefined', () => {
      expect(estimateLlmCostUsd('anthropic', undefined, { inputTokens: 1000, outputTokens: 500 })).toBeNull();
    });

    it('returns null when usage is undefined', () => {
      expect(estimateLlmCostUsd('anthropic', 'claude-sonnet-4-6', undefined)).toBeNull();
    });

    it('returns null for an unsupported provider', () => {
      expect(estimateLlmCostUsd('google', 'gemini-1.5-pro', { inputTokens: 1000, outputTokens: 500 })).toBeNull();
    });

    it('returns null for an unmatched anthropic model', () => {
      expect(estimateLlmCostUsd('anthropic', 'claude-unknown-99', { inputTokens: 1000, outputTokens: 500 })).toBeNull();
    });
  });

  describe('anthropic pricing', () => {
    it('prices claude-haiku-4-5 at $1/$5 per MTok', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(cost).toBeCloseTo(6, 5);
    });

    it('prices dated claude-haiku-4-5 variant via prefix match', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 });
      expect(cost).toBeCloseTo(1, 5);
    });

    it('prices claude-sonnet-4-6 at $3/$15 per MTok via claude-sonnet-4 prefix', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(cost).toBeCloseTo(18, 5);
    });

    it('prices claude-sonnet-5 at $3/$15 per MTok', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-sonnet-5', { inputTokens: 2_000_000, outputTokens: 1_000_000 });
      expect(cost).toBeCloseTo(21, 5);
    });

    it('prices claude-opus-5 at $5/$25 per MTok', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(cost).toBeCloseTo(30, 5);
    });

    it('prefix ordering: claude-sonnet-5-dated does not fall through to claude-sonnet-4 entry', () => {
      const cost = estimateLlmCostUsd('anthropic', 'claude-sonnet-5-20261001', { inputTokens: 1_000_000, outputTokens: 0 });
      expect(cost).toBeCloseTo(3, 5);
    });
  });

  describe('openai delegation', () => {
    it('returns a number for a known openai model via inlined pricing table', () => {
      const cost = estimateLlmCostUsd('openai', 'gpt-4o', { inputTokens: 0, outputTokens: 0 });
      expect(cost).toEqual(expect.any(Number));
    });
  });
});
