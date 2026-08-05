import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AIErrorCategory } from '../../../shared/errors/app.error';

/**
 * Classifies a caught SDK error into an AIErrorCategory.
 * Returns undefined for unrecognised errors so callers preserve existing behaviour.
 * Detection order is most-specific-first: timeout subclasses before their parent
 * connection class, then auth, then rate-limit, then a message-based regex fallback
 * that covers SDKs without a typed error hierarchy (e.g. Gemini).
 *
 * @param error - Unknown thrown value from an AI SDK call
 * @returns The matching AIErrorCategory, or undefined when no category applies
 */
export const classifyAiSdkError = (error: unknown): AIErrorCategory | undefined => {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';

  if (error instanceof Anthropic.APIConnectionError) return 'timeout';
  if (error instanceof OpenAI.APIConnectionError) return 'timeout';

  if (error instanceof Anthropic.AuthenticationError) return 'auth';
  if (error instanceof OpenAI.AuthenticationError) return 'auth';

  if (error instanceof Anthropic.RateLimitError) return 'api';
  if (error instanceof OpenAI.RateLimitError) return 'api';

  if (error instanceof Error && /\btimed?\s*out\b/i.test(error.message)) return 'timeout';

  return undefined;
};
