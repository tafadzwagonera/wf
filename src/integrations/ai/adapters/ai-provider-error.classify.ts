import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiProviderErrorCategory } from '../../../shared/errors/app.error';

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

  // Client-side SDK errors are thrown before any request leaves the process, so the
  // request parameters themselves are invalid. Retrying cannot help.
  if (isClientSideSdkError(error)) return 'config';

  return undefined;
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
