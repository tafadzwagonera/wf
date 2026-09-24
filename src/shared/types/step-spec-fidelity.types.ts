import type { z } from 'zod';
import type { stepFidelityFindingSchema } from '../schemas/step-spec-fidelity.schema';

export type StepFidelityFinding = z.infer<typeof stepFidelityFindingSchema>;

export type StepFidelityFailureCategory = 'diff' | 'provider' | 'response';

export interface StepFidelityFailure {
  category: StepFidelityFailureCategory;
  stepIndex?: number;
  cause: string;
}

export interface StepFidelityVerificationResult {
  findingsPerStep: StepFidelityFinding[][];
  failures: StepFidelityFailure[];
}
