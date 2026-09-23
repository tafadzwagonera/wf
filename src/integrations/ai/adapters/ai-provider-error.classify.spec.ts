import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { classifyAiSdkError, isUnavailableModelError } from './ai-provider-error.classify';
import { AiProviderError } from '../../../shared/utils/errors';

describe('classifyAiSdkError', () => {
  it('returns timeout for Anthropic APIConnectionTimeoutError', () => {
    expect(classifyAiSdkError(new Anthropic.APIConnectionTimeoutError({}))).toBe('timeout');
  });

  it('returns timeout for OpenAI APIConnectionTimeoutError', () => {
    expect(classifyAiSdkError(new OpenAI.APIConnectionTimeoutError({}))).toBe('timeout');
  });

  it('returns timeout for Anthropic APIConnectionError (non-timeout)', () => {
    expect(classifyAiSdkError(new Anthropic.APIConnectionError({ message: 'conn refused' }))).toBe('timeout');
  });

  it('returns timeout for OpenAI APIConnectionError (non-timeout)', () => {
    expect(classifyAiSdkError(new OpenAI.APIConnectionError({ message: 'conn refused' }))).toBe('timeout');
  });

  it('returns auth for Anthropic AuthenticationError', () => {
    expect(classifyAiSdkError(new Anthropic.AuthenticationError(401, undefined, 'invalid key', new Headers()))).toBe('auth');
  });

  it('returns auth for OpenAI AuthenticationError', () => {
    expect(classifyAiSdkError(new OpenAI.AuthenticationError(401, undefined, 'invalid key', new Headers()))).toBe('auth');
  });

  it('returns api for Anthropic RateLimitError', () => {
    expect(classifyAiSdkError(new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()))).toBe('api');
  });

  it('returns api for OpenAI RateLimitError', () => {
    expect(classifyAiSdkError(new OpenAI.RateLimitError(429, undefined, 'rate limited', new Headers()))).toBe('api');
  });

  it('returns timeout for a generic Error with "timed out" in the message (Gemini fallback)', () => {
    expect(classifyAiSdkError(new Error('Request timed out.'))).toBe('timeout');
  });

  it('returns config for a client-side AnthropicError', () => {
    expect(classifyAiSdkError(new Anthropic.AnthropicError('Streaming is required for operations that may take longer than 10 minutes.'))).toBe('config');
  });

  it('returns config for a client-side OpenAIError', () => {
    expect(classifyAiSdkError(new OpenAI.OpenAIError('bad request shape'))).toBe('config');
  });

  it('returns config for invalid provider JSON schema errors', () => {
    expect(classifyAiSdkError(new OpenAI.APIError(400, {
      message: 'Invalid schema for response_format: invalid_json_schema at text.format.schema',
      code: 'invalid_json_schema',
      param: 'text.format.schema',
    }, 'bad request', new Headers()))).toBe('config');
  });

  it('prefers the specific category over config for typed API errors', () => {
    expect(classifyAiSdkError(new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()))).toBe('auth');
  });

  it('returns undefined for a generic Error without a timeout message', () => {
    expect(classifyAiSdkError(new Error('Some other error'))).toBeUndefined();
  });

  it('returns undefined for a string', () => {
    expect(classifyAiSdkError('string error')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(classifyAiSdkError(null)).toBeUndefined();
  });
});

describe('isUnavailableModelError', () => {
  it('returns true for AiProviderError with model not found message', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found'))).toBe(true);
  });

  it('returns true for AiProviderError with does not exist message', () => {
    expect(isUnavailableModelError(new AiProviderError('The model does not exist'))).toBe(true);
  });

  it('returns true for AiProviderError with may not exist message', () => {
    expect(isUnavailableModelError(new AiProviderError("The model 'gpt-x' may not exist or you do not have access"))).toBe(true);
  });

  it('returns true for AiProviderError with invalid model message', () => {
    expect(isUnavailableModelError(new AiProviderError('invalid model: gpt-x-unknown'))).toBe(true);
  });

  it('returns true for AiProviderError with model unavailable message', () => {
    expect(isUnavailableModelError(new AiProviderError('model unavailable at this time'))).toBe(true);
  });

  it('returns true for AiProviderError with deployment not found message', () => {
    expect(isUnavailableModelError(new AiProviderError('deployment not found for this region'))).toBe(true);
  });

  it('returns true for AiProviderError with model-associated 404 in details', () => {
    expect(isUnavailableModelError(new AiProviderError('Request failed', { error: 'deployment not found', statusCode: 404 }))).toBe(true);
  });

  it('returns true for AiProviderError with api category and model not found message', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'api'))).toBe(true);
  });

  it('returns true for AiProviderError with model name containing hyphens (e.g. gpt-4-turbo)', () => {
    expect(isUnavailableModelError(new AiProviderError('model gpt-4-turbo not found', undefined, true, 'api'))).toBe(true);
  });

  it('returns true for raw Error with Codex may not exist wording', () => {
    expect(isUnavailableModelError(new Error("The model 'codex-ultra' may not exist or you may not have access to it"))).toBe(true);
  });

  it('returns false for AiProviderError with auth category', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'auth'))).toBe(false);
  });

  it('returns false for AiProviderError with timeout category', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'timeout'))).toBe(false);
  });

  it('returns false for AiProviderError with parse category', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'parse'))).toBe(false);
  });

  it('returns false for AiProviderError with config category', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'config'))).toBe(false);
  });

  it('returns false for AiProviderError with rate-limit category', () => {
    expect(isUnavailableModelError(new AiProviderError('model not found', undefined, true, 'rate-limit'))).toBe(false);
  });

  it('returns false for a generic unrelated Error', () => {
    expect(isUnavailableModelError(new Error('Something went wrong unexpectedly'))).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isUnavailableModelError('model not found')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUnavailableModelError(null)).toBe(false);
  });
});
