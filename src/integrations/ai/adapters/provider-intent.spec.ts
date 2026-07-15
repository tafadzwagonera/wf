import type { WfAiProviderConfig, WfAiProviderName } from '../../../config/public-config';
import { hasProviderUsageIntent, extractStageProviders } from './provider-intent';

describe('hasProviderUsageIntent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when provider is the explicit default', () => {
    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'anthropic')).toBe(true);
  });

  it('returns false for non-default provider without stage override', () => {
    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai')).toBe(false);
  });

  it('returns true for non-default provider with matching stage override', () => {
    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6', default: true },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: false },
    ];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai', ['openai'])).toBe(
      true
    );
  });

  it('returns true for implicit first-entry default when no provider has default: true', () => {
    const providers = [
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1' },
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6' },
    ];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai')).toBe(true);
  });

  it('returns false for second entry when no provider has default: true', () => {
    const providers = [
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1' },
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6' },
    ];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'anthropic')).toBe(false);
  });

  it('returns false for explicit default when every stage overrides to a different provider', () => {
    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6' },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: true },
    ];
    const stageProviders: (WfAiProviderName | undefined)[] = ['anthropic', 'anthropic', 'anthropic'];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai', stageProviders)).toBe(
      false
    );
  });

  it('returns true for explicit default when at least one stage has no override', () => {
    const providers = [
      { provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6' },
      { provider: 'openai', apiKey: 'sk-xxx', model: 'gpt-4.1', default: true },
    ];
    const stageProviders: (WfAiProviderName | undefined)[] = ['anthropic', undefined, 'anthropic'];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai', stageProviders)).toBe(
      true
    );
  });

  it('returns false when provider has no apiKey', () => {
    const providers = [{ provider: 'openai', apiKey: '', model: 'gpt-4.1', default: true }];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai')).toBe(false);
  });

  it('returns false when provider has no model', () => {
    const providers = [{ provider: 'openai', apiKey: 'sk-xxx', model: '', default: true }];
    expect(hasProviderUsageIntent(providers as WfAiProviderConfig[], 'openai')).toBe(false);
  });

  it('returns false when providers is undefined', () => {
    expect(hasProviderUsageIntent(undefined, 'openai')).toBe(false);
  });
});

describe('extractStageProviders', () => {
  it('returns provider names from stage overrides', () => {
    const stages = {
      plan: { provider: 'anthropic' as WfAiProviderName },
      review: { provider: 'openai' as WfAiProviderName },
      implement: {},
    };
    expect(extractStageProviders(stages)).toEqual(['anthropic', 'openai', undefined]);
  });

  it('returns empty array when stages is undefined', () => {
    expect(extractStageProviders(undefined)).toEqual([]);
  });

  it('returns array of undefined when no stages have provider overrides', () => {
    const stages = { plan: {}, review: {} };
    expect(extractStageProviders(stages)).toEqual([undefined, undefined]);
  });

  it('skips undefined stage values without throwing', () => {
    const stages = { plan: undefined, review: { provider: 'openai' as WfAiProviderName }, commit: undefined };
    expect(extractStageProviders(stages)).toEqual([undefined, 'openai', undefined]);
  });
});
