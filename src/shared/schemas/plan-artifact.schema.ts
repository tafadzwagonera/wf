import { z } from 'zod';

export const resolutionActionSchema = z.enum(['feature', 'fix', 'investigate']);

export const planArtifactFormatSchema = z.enum(['json', 'md', 'yaml', 'yml']);

export const planArtifactManifestSchema = z.object({
  artifactPath: z.string(),
  action: resolutionActionSchema,
  createdAt: z.string(),
  format: planArtifactFormatSchema,
  hash: z.string(),
  sourceKind: z.enum(['ticket', 'custom']),
  sourceName: z.string(),
  ticketKey: z.string().optional(),
  customArtifactName: z.string().optional(),
  trackerName: z.string().optional(),
  sourceBranch: z.string().optional(),
  branchName: z.string().optional(),
  figmaLinks: z.array(z.string()).optional(),
});

export const planArtifactReferenceSchema = z.object({
  action: resolutionActionSchema,
  artifactPath: z.string(),
  format: planArtifactFormatSchema,
  hash: z.string(),
  manifestPath: z.string().optional(),
  sourceKind: z.enum(['ticket', 'custom']),
  sourceName: z.string(),
  ticketKey: z.string().optional(),
  customArtifactName: z.string().optional(),
  isLegacy: z.boolean(),
});

export const planTokenResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ticket'),
    ticketKey: z.string(),
  }),
  z.object({
    kind: z.literal('custom'),
    artifactPath: z.string(),
    action: resolutionActionSchema,
    sourceName: z.string(),
  }),
]);

export const generatedTicketSourceManifestSchema = z.object({
  artifactPath: z.string(),
  createdAt: z.string(),
  format: z.string(),
  hash: z.string(),
  trackerName: z.string(),
  sources: z.array(z.string()),
});
