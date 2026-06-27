import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ConfigurationError, ExecutionError } from '../../shared/utils/errors';
import type {
  SlackMessage,
  SlackThreadResult,
  SlackChannelHistoryResult,
  SlackApiOptions,
} from '../../shared/types/slack.types';

export type {
  SlackMessage,
  SlackThreadResult,
  SlackChannelHistoryResult,
  SlackApiOptions,
} from '../../shared/types/slack.types';

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
      {
        channel: channelId,
        limit,
      },
      channelId,
      { fallbackOnChannelNotFound: true }
    );

    return {
      channelId,
      messages: this.mapSlackMessages(response.messages ?? []),
    };
  }

  async fetchThread(channelId: string, threadTs: string): Promise<SlackThreadResult> {
    const response = await this.callSlackApi(
      'https://slack.com/api/conversations.replies',
      {
        channel: channelId,
        ts: threadTs,
      },
      channelId,
      { fallbackOnChannelNotFound: true }
    );

    return {
      channelId,
      threadTs,
      messages: this.mapSlackMessages(response.messages ?? []),
    };
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
  ): Promise<any> {
    const primaryToken = this.getSlackToken('bot');
    const userToken = this.getSlackToken('user');
    const tokens = primaryToken
      ? [primaryToken, ...(userToken && userToken !== primaryToken ? [userToken] : [])]
      : userToken
        ? [userToken]
        : [];

    if (tokens.length === 0) {
      throw new ConfigurationError('Set slack.botToken or slack.userToken before using Slack sources');
    }

    let lastResponseData: any;

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const response = await axios.get(endpoint, {
        params,
        headers: { Authorization: `Bearer ${token}` },
      });

      lastResponseData = response.data;

      if (response.data?.ok) {
        return response.data;
      }

      const shouldRetry =
        options.fallbackOnChannelNotFound && response.data?.error === 'channel_not_found' && index < tokens.length - 1;

      if (!shouldRetry) {
        this.ensureSlackResponseOk(response.data, channelId);
      }
    }

    this.ensureSlackResponseOk(lastResponseData, channelId);
    throw new Error('Unreachable Slack API state');
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

    return token ? token : undefined;
  }

  /**
   * Convert Slack API message payloads into the internal message shape.
   *
   * @param messages - Raw Slack message objects
   * @returns Simplified Slack message list
   */
  private mapSlackMessages(messages: any[]): SlackMessage[] {
    return messages.map((message: any) => ({
      user: message.user ?? message.bot_id ?? 'unknown',
      ts: message.ts,
      text: message.text ?? '',
    }));
  }

  /**
   * Raise a clear error when Slack reports an API failure.
   *
   * @param responseData - Raw Slack API response body
   * @param channelId - Channel associated with the request
   * @returns Nothing; throws when the response is not ok
   */
  private ensureSlackResponseOk(responseData: any, channelId: string): void {
    if (responseData.ok) {
      return;
    }

    const error = responseData.error as string;
    if (error === 'not_in_channel') {
      throw new ExecutionError(
        `Slack bot is not a member of channel ${channelId}. ` +
          `Invite it first: open the channel in Slack and run /invite @<your-bot-name>`
      );
    }
    if (error === 'channel_not_found') {
      throw new ExecutionError(
        `Slack channel ${channelId} not found. ` +
          `Check the permalink, ensure the token has access to the workspace, or configure slack.userToken for DM/MPDM conversations.`
      );
    }
    throw new ExecutionError(`Slack API error: ${error}`);
  }
}
