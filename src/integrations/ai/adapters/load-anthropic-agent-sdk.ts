/**
 * Load the Anthropic Agent SDK lazily so the CommonJS CLI does not try to
 * resolve the ESM-only package at module initialization time.
 *
 * @returns The loaded Anthropic Agent SDK module
 */
export const loadAnthropicAgentSdk = async (): Promise<
  typeof import('@anthropic-ai/claude-agent-sdk')
> => import('@anthropic-ai/claude-agent-sdk');
