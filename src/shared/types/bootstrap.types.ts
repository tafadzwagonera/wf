import type { z } from 'zod';
import type {
  commandHelpOptionSchema,
  commandHelpExampleSchema,
  commandHelpEntrySchema,
  cliExampleSchema,
} from '../schemas/bootstrap.schema';

export type CommandHelpOption = z.infer<typeof commandHelpOptionSchema>;
export type CommandHelpExample = z.infer<typeof commandHelpExampleSchema>;
export type CommandHelpEntry = z.infer<typeof commandHelpEntrySchema>;
export type CliExample = z.infer<typeof cliExampleSchema>;
