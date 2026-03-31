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
    mockConfigService.get.mockReturnValue('xoxb-test-token');
    slackService = new SlackService(
      mockConfigService as unknown as ConfigService,
    );
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
        }),
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

      await expect(
        slackService.fetchChannelHistory('C0AP5MMCP53', 50),
      ).rejects.toThrow(
        'Slack bot is not a member of channel C0AP5MMCP53. Invite it first: open the channel in Slack and run /invite @<your-bot-name>',
      );
    });

    it('raises a clear error when the channel cannot be found', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: false,
          error: 'channel_not_found',
        },
      } as any);

      await expect(
        slackService.fetchChannelHistory('C0AP5MMCP53', 50),
      ).rejects.toThrow(
        'Slack channel C0AP5MMCP53 not found. Check the permalink or ensure the bot has access to the workspace.',
      );
    });

    it('raises the Slack API error for other failures', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          ok: false,
          error: 'internal_error',
        },
      } as any);

      await expect(
        slackService.fetchChannelHistory('C0AP5MMCP53', 50),
      ).rejects.toThrow('Slack API error: internal_error');
    });
  });
});
