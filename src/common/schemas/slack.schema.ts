import { z } from 'zod';

export const slackMessageSchema = z.object({
  user: z.string(),
  ts: z.string(),
  text: z.string(),
});

export const slackThreadResultSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  messages: z.array(slackMessageSchema),
});

export const slackChannelHistoryResultSchema = z.object({
  channelId: z.string(),
  messages: z.array(slackMessageSchema),
});

export const slackApiOptionsSchema = z.object({
  fallbackOnChannelNotFound: z.boolean().optional(),
});
