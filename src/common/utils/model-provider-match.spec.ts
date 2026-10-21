import { findModelProviderMismatch } from './model-provider-match';

describe('findModelProviderMismatch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the offending prefix and expected provider on mismatch', () => {
    expect(findModelProviderMismatch('anthropic', 'gpt-4o')).toEqual({ prefix: 'gpt-', expectedProvider: 'openai' });
  });

  it('returns null when the prefix matches the provider', () => {
    expect(findModelProviderMismatch('openai', 'gpt-4o')).toBeNull();
  });

  it('returns null for an unknown model prefix', () => {
    expect(findModelProviderMismatch('anthropic', 'custom-model')).toBeNull();
  });

  it('treats an unknown provider as a mismatch for a mapped prefix', () => {
    expect(findModelProviderMismatch('unknownprov', 'claude-x')).toEqual({
      prefix: 'claude-',
      expectedProvider: 'anthropic',
    });
  });
});
