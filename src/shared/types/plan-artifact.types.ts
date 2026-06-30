import type { z } from 'zod';
import type {
  generatedTicketSourceManifestSchema,
  planArtifactFormatSchema,
  planArtifactManifestSchema,
  planArtifactReferenceSchema,
  planTokenResolutionSchema,
  resolutionActionSchema,
} from '../schemas/plan-artifact.schema';

export type GeneratedTicketSourceManifest = z.infer<typeof generatedTicketSourceManifestSchema>;
export type PlanArtifactFormat = z.infer<typeof planArtifactFormatSchema>;
export type PlanArtifactManifest = z.infer<typeof planArtifactManifestSchema>;
export type PlanArtifactReference = z.infer<typeof planArtifactReferenceSchema>;
export type PlanTokenResolution = z.infer<typeof planTokenResolutionSchema>;
export type ResolutionAction = z.infer<typeof resolutionActionSchema>;
