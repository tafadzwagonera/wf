import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { classifyAiSdkError } from './ai-error.classify';

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
