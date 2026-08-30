import type { z } from 'zod';
import type {
  stepAssessmentResponseSchema,
  stepAssessmentSchema,
  stepStatusSchema,
} from '../schemas/step-verification.schema';

export type StepStatus = z.infer<typeof stepStatusSchema>;
export type StepAssessment = z.infer<typeof stepAssessmentSchema>;
export type StepAssessmentResponse = z.infer<typeof stepAssessmentResponseSchema>;

export type StepVerificationSummary = {
  rounds: number;
  done: number;
  pending: number;
};
