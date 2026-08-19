import type { z } from 'zod';
import type {
  commandHelpOptionSchema,
  commandHelpExampleSchema,
  commandHelpEntrySchema,
} from '../schemas/bootstrap.schema';

export type CommandHelpEntry = z.infer<typeof commandHelpEntrySchema>;
export type CommandHelpExample = z.infer<typeof commandHelpExampleSchema>;
export type CommandHelpOption = z.infer<typeof commandHelpOptionSchema>;
