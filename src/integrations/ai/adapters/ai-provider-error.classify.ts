import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiProviderErrorCategory } from '../../../common/errors/app.error';
import { isAiProviderErrorLike } from '../../../common/utils/errors';

/**
 * Classifies a caught SDK error into an AiProviderErrorCategory.
 * Returns undefined for unrecognised errors so callers preserve existing behaviour.
 * Detection order is most-specific-first: timeout subclasses before their parent
 * connection class, then auth, then rate-limit, then a message-based regex fallback
 * that covers SDKs without a typed error hierarchy (e.g. Gemini).
 *
 * @param error - Unknown thrown value from an AI SDK call
 * @returns The matching AiProviderErrorCategory, or undefined when no category applies
 */
export const classifyAiSdkError = (error: unknown): AiProviderErrorCategory | undefined => {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';

  if (error instanceof Anthropic.APIConnectionError) return 'timeout';
  if (error instanceof OpenAI.APIConnectionError) return 'timeout';

  if (error instanceof Anthropic.AuthenticationError) return 'auth';
  if (error instanceof OpenAI.AuthenticationError) return 'auth';

  if (error instanceof Anthropic.RateLimitError) return 'api';
  if (error instanceof OpenAI.RateLimitError) return 'api';

  if (error instanceof Error && /\btimed?\s*out\b/i.test(error.message)) return 'timeout';

  if (isInvalidJsonSchemaError(error)) return 'config';

  // Client-side SDK errors are thrown before any request leaves the process, so the
  // request parameters themselves are invalid. Retrying cannot help.
  if (isClientSideSdkError(error)) return 'config';

  return undefined;
};

const isInvalidJsonSchemaError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const details = typeof error === 'object' ? JSON.stringify(error) : '';
  return /invalid_json_schema|text\.format\.schema/i.test(`${error.message} ${details}`);
};

/**
 * Detects SDK errors raised locally during request validation rather than returned by
 * the provider. These are base SDK error types that are not APIError subclasses — e.g.
 * the Anthropic SDK rejecting a non-streaming request whose max_tokens implies a
 * response longer than its 10-minute non-streaming ceiling.
 *
 * @param error - Unknown thrown value from an AI SDK call
 * @returns True when the SDK rejected the request before dispatching it
 */
const isClientSideSdkError = (error: unknown): boolean => {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) return false;
  return error instanceof Anthropic.AnthropicError || error instanceof OpenAI.OpenAIError;
};

const MODEL_UNAVAILABLE_PATTERN = /(?:model|deployment)[^.]*(?:not found|does not exist|may not exist|invalid|unavailable|404)|(?:invalid|unknown|unsupported)\s+model|(?:model|deployment)[^.]*\b404\b/i;

export const isUnavailableModelError = (error: unknown): boolean => {
  if (isAiProviderErrorLike(error)) {
    if (error.category !== undefined && error.category !== 'api') return false;
    const details = typeof error.details === 'object' && error.details !== null ? JSON.stringify(error.details) : '';
    return MODEL_UNAVAILABLE_PATTERN.test(`${error.message} ${details}`);
  }
  if (error instanceof Error) {
    const category = classifyAiSdkError(error);
    if (category !== undefined && category !== 'api') return false;
    return MODEL_UNAVAILABLE_PATTERN.test(error.message);
  }
  return false;
};
