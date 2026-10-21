import type { z } from 'zod';
import type { errorCodeSchema, appErrorSchema, apiErrorSchema } from '../schemas/error.schema';

export type ApiErrorData = z.infer<typeof apiErrorSchema>;
export type AppErrorData = z.infer<typeof appErrorSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
