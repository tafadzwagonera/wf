import type { z } from 'zod';
import type {
  slackApiOptionsSchema,
  slackChannelHistoryResultSchema,
  slackMessageSchema,
  slackThreadResultSchema,
} from '../schemas/slack.schema';

export type SlackApiOptions = z.infer<typeof slackApiOptionsSchema>;
export type SlackChannelHistoryResult = z.infer<typeof slackChannelHistoryResultSchema>;
export type SlackMessage = z.infer<typeof slackMessageSchema>;
export type SlackThreadResult = z.infer<typeof slackThreadResultSchema>;
