import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SlackService } from './slack.service';

jest.mock('axios');

const mockAxios = axios as jest.Mocked<typeof axios>;

describe('SlackService', () => {
  const mockConfigService = {
    get: jest.fn(),
  };

  let slackService: SlackService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'slack.botToken') return 'xoxb-test-token';
      return undefined;
    });
    slackService = new SlackService(mockConfigService as unknown as ConfigService);
  });

  describe('fetchChannelHistory', () => {
    it('returns mapped channel messages from conversations.history', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: true,
          messages: [
            {
              ts: '1712345678.123456',
              user: 'U123',
              text: 'Latest channel message',
            },
          ],
        },
      } as any);

      const result = await slackService.fetchChannelHistory('C0AP5MMCP53', 50);

      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.history',
        expect.objectContaining({
          params: { channel: 'C0AP5MMCP53', limit: 50 },
        })
      );
      expect(result).toEqual({
        channelId: 'C0AP5MMCP53',
        messages: [
          {
            ts: '1712345678.123456',
            user: 'U123',
            text: 'Latest channel message',
          },
        ],
      });
    });

    it('raises a clear error when the bot is not in the channel', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: false,
          error: 'not_in_channel',
        },
      } as any);

      await expect(slackService.fetchChannelHistory('C0AP5MMCP53', 50)).rejects.toThrow(
        'Slack bot is not a member of channel C0AP5MMCP53. Invite it first: open the channel in Slack and run /invite @<your-bot-name>'
      );
    });

    it('raises a clear error when the channel cannot be found', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: false,
          error: 'channel_not_found',
        },
      } as any);

      await expect(slackService.fetchChannelHistory('C0AP5MMCP53', 50)).rejects.toThrow(
        'Slack channel C0AP5MMCP53 not found. Check the permalink, ensure the token has access to the workspace, or configure slack.userToken for DM/MPDM conversations.'
      );
    });

    it('raises the Slack API error for other failures', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: false,
          error: 'internal_error',
        },
      } as any);

      await expect(slackService.fetchChannelHistory('C0AP5MMCP53', 50)).rejects.toThrow(
        'Slack API error: internal_error'
      );
    });

    it('retries with a configured user token when the bot token cannot resolve the conversation', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'slack.botToken') return 'xoxb-test-token';
        if (key === 'slack.userToken') return 'xoxp-test-token';
        return undefined;
      });

      mockAxios.get
        .mockResolvedValueOnce({
          data: {
            ok: false,
            error: 'channel_not_found',
          },
        } as any)
        .mockResolvedValueOnce({
          data: {
            ok: true,
            messages: [
              {
                ts: '1712345678.123456',
                user: 'U123',
                text: 'Recovered with user token',
              },
            ],
          },
        } as any);

      const result = await slackService.fetchChannelHistory('C0AP5MMCP53', 50);

      expect(mockAxios.get).toHaveBeenNthCalledWith(
        1,
        'https://slack.com/api/conversations.history',
        expect.objectContaining({
          params: { channel: 'C0AP5MMCP53', limit: 50 },
          headers: { Authorization: 'Bearer xoxb-test-token' },
        })
      );
      expect(mockAxios.get).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.history',
        expect.objectContaining({
          params: { channel: 'C0AP5MMCP53', limit: 50 },
          headers: { Authorization: 'Bearer xoxp-test-token' },
        })
      );
      expect(result.messages[0].text).toBe('Recovered with user token');
    });
  });
});
