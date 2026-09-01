import type { z } from 'zod';
import type { stepFidelityFindingSchema } from '../schemas/step-spec-fidelity.schema';

export type StepFidelityFinding = z.infer<typeof stepFidelityFindingSchema>;
