import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface SlackMessage {
  user: string;
  ts: string;
  text: string;
}

interface SlackThreadResult {
  channelId: string;
  threadTs: string;
  messages: SlackMessage[];
}

interface SlackChannelHistoryResult {
  channelId: string;
  messages: SlackMessage[];
}

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
  async fetchChannelHistory(
    channelId: string,
    limit: number,
  ): Promise<SlackChannelHistoryResult> {
    const token = this.getSlackToken();
    const response = await axios.get(
      'https://slack.com/api/conversations.history',
      {
        params: { channel: channelId, limit },
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    this.ensureSlackResponseOk(response.data, channelId);

    return {
      channelId,
      messages: this.mapSlackMessages(response.data.messages ?? []),
    };
  }

  async fetchThread(
    channelId: string,
    threadTs: string,
  ): Promise<SlackThreadResult> {
    const token = this.getSlackToken();

    const response = await axios.get(
      'https://slack.com/api/conversations.replies',
      {
        params: { channel: channelId, ts: threadTs },
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    this.ensureSlackResponseOk(response.data, channelId);

    return {
      channelId,
      threadTs,
      messages: this.mapSlackMessages(response.data.messages ?? []),
    };
  }

  /**
   * Resolve the Slack bot token needed for API calls.
   *
   * @returns Slack bot token
   */
  private getSlackToken(): string {
    const token = this.configService.get<string>('slack.botToken');
    if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
    return token;
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
      throw new Error(
        `Slack bot is not a member of channel ${channelId}. ` +
          `Invite it first: open the channel in Slack and run /invite @<your-bot-name>`,
      );
    }
    if (error === 'channel_not_found') {
      throw new Error(
        `Slack channel ${channelId} not found. ` +
          `Check the permalink or ensure the bot has access to the workspace.`,
      );
    }
    throw new Error(`Slack API error: ${error}`);
  }
}
