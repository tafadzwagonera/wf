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

@Injectable()
export class SlackService {
  constructor(private readonly configService: ConfigService) {}

  async fetchThread(channelId: string, threadTs: string): Promise<SlackThreadResult> {
    const token = this.configService.get<string>('slack.botToken');
    if (!token) throw new Error('SLACK_BOT_TOKEN is not set');

    const response = await axios.get('https://slack.com/api/conversations.replies', {
      params: { channel: channelId, ts: threadTs },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    const messages: SlackMessage[] = (response.data.messages ?? []).map((m: any) => ({
      user: m.user ?? m.bot_id ?? 'unknown',
      ts: m.ts,
      text: m.text ?? '',
    }));

    return { channelId, threadTs, messages };
  }
}
