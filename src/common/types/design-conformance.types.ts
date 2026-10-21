import type { z } from 'zod';
import type { designConformanceFindingSchema } from '../schemas/design-conformance.schema';

export type DesignConformanceFinding = z.infer<typeof designConformanceFindingSchema>;
