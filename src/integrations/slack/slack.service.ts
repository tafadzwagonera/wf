import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ConfigurationError, ExecutionError } from '../../common/utils/errors';
import type {
  SlackMessage,
  SlackThreadResult,
  SlackChannelHistoryResult,
  SlackApiOptions,
} from '../../common/types/slack.types';

export type {
  SlackMessage,
  SlackThreadResult,
  SlackChannelHistoryResult,
  SlackApiOptions,
} from '../../common/types/slack.types';

/**
 * Build the ordered list of tokens to attempt for a Slack API call.
 *
 * @param botToken - Configured bot token, if any
 * @param userToken - Configured user token, if any
 * @returns Non-empty token list, or throws when neither token is set
 */
const resolveSlackTokens = (botToken: string | undefined, userToken: string | undefined): string[] => {
  if (botToken) {
    return [botToken, ...(userToken && userToken !== botToken ? [userToken] : [])];
  }
  if (userToken) {
    return [userToken];
  }
  throw new ConfigurationError('Set slack.botToken or slack.userToken before using Slack sources');
};

/**
 * Execute a single GET request against a Slack Web API endpoint.
 *
 * @param endpoint - Slack API URL
 * @param params - Query string parameters
 * @param token - Bearer token for the request
 * @returns Raw Slack API response data
 */
const executeSlackGet = async (
  endpoint: string,
  params: Record<string, string | number>,
  token: string
): Promise<Record<string, unknown>> => {
  const response = await axios.get(endpoint, {
    params,
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data as Record<string, unknown>;
};

/**
 * Determine whether a failed Slack response should be retried with the next token.
 *
 * @param data - Raw Slack API response body for the current attempt
 * @param options - Retry behavior options for the call
 * @param index - Zero-based index of the current token in the token list
 * @param total - Total number of tokens available
 * @returns True when the caller should proceed to the next token
 */
const isSlackRetryable = (
  data: Record<string, unknown>,
  options: SlackApiOptions,
  index: number,
  total: number
): boolean => options.fallbackOnChannelNotFound === true && data.error === 'channel_not_found' && index < total - 1;

/**
 * Build a human-readable error message for a known Slack API error code.
 *
 * @param error - Slack error code from the response body
 * @param channelId - Channel associated with the request
 * @returns Formatted error message string
 */
const formatSlackError = (error: string, channelId: string): string => {
  switch (error) {
    case 'not_in_channel':
      return `Slack bot is not a member of channel ${channelId}. Invite it first: open the channel in Slack and run /invite @<your-bot-name>`;
    case 'channel_not_found':
      return `Slack channel ${channelId} not found. Check the permalink, ensure the token has access to the workspace, or configure slack.userToken for DM/MPDM conversations.`;
    default:
      return `Slack API error: ${error}`;
  }
};

@Injectable()
export class SlackService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Fetch a bounded slice of recent Slack channel history.
   *
   * @param channelId - Slack channel ID from the archive URL
   * @param limit - Maximum number of messages to return
   * @returns Channel history messages for synthesis
   */
  async fetchChannelHistory(channelId: string, limit: number): Promise<SlackChannelHistoryResult> {
    const response = await this.callSlackApi(
      'https://slack.com/api/conversations.history',
      { channel: channelId, limit },
      channelId,
      { fallbackOnChannelNotFound: true }
    );
    return { channelId, messages: this.mapSlackMessages((response.messages as unknown[]) ?? []) };
  }

  /**
   * Fetch all replies in a Slack thread.
   *
   * @param channelId - Slack channel containing the thread
   * @param threadTs - Timestamp of the thread's root message
   * @returns Thread messages in chronological order
   */
  async fetchThread(channelId: string, threadTs: string): Promise<SlackThreadResult> {
    const response = await this.callSlackApi(
      'https://slack.com/api/conversations.replies',
      { channel: channelId, ts: threadTs },
      channelId,
      { fallbackOnChannelNotFound: true }
    );
    return { channelId, threadTs, messages: this.mapSlackMessages((response.messages as unknown[]) ?? []) };
  }

  /**
   * Execute a Slack Web API call with optional fallback to a user token.
   *
   * @param endpoint - Slack API endpoint URL
   * @param params - Query string params for the request
   * @param channelId - Conversation identifier for error messages
   * @param options - Retry behavior options
   * @returns Raw Slack API response data
   */
  private async callSlackApi(
    endpoint: string,
    params: Record<string, string | number>,
    channelId: string,
    options: SlackApiOptions = {}
  ): Promise<Record<string, unknown>> {
    const tokens = resolveSlackTokens(this.getSlackToken('bot'), this.getSlackToken('user'));
    let lastData: Record<string, unknown> = {};
    for (const [index, token] of tokens.entries()) {
      lastData = await executeSlackGet(endpoint, params, token);
      if (lastData.ok) return lastData;
      if (!isSlackRetryable(lastData, options, index, tokens.length)) this.ensureSlackResponseOk(lastData, channelId);
    }
    this.throwSlackError(lastData, channelId);
  }

  /**
   * Resolve the configured Slack token for the requested token type.
   *
   * @param tokenType - Slack token category to resolve
   * @returns Slack token when configured
   */
  private getSlackToken(tokenType: 'bot' | 'user'): string | undefined {
    const configKey = tokenType === 'bot' ? 'slack.botToken' : 'slack.userToken';
    const token = this.configService.get<string>(configKey)?.trim();
    return token || undefined;
  }

  /**
   * Convert Slack API message payloads into the internal message shape.
   *
   * @param messages - Raw Slack message objects
   * @returns Simplified Slack message list
   */
  private mapSlackMessages(messages: unknown[]): SlackMessage[] {
    return messages.map(message => {
      const m = message as Record<string, string | undefined>;
      return { user: m.user ?? m.bot_id ?? 'unknown', ts: m.ts ?? '', text: m.text ?? '' };
    });
  }

  /**
   * Raise a clear error when Slack reports an API failure.
   *
   * @param responseData - Raw Slack API response body
   * @param channelId - Channel associated with the request
   */
  private throwSlackError(responseData: Record<string, unknown>, channelId: string): never {
    throw new ExecutionError(formatSlackError(responseData.error as string, channelId));
  }

  private ensureSlackResponseOk(responseData: Record<string, unknown>, channelId: string): void {
    if (!responseData.ok) this.throwSlackError(responseData, channelId);
  }
}
