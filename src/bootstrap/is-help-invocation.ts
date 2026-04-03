const HELP_FLAGS = new Set(['-h', '--help']);

/**
 * Determine whether CLI args request command help and can bypass config bootstrap.
 *
 * @param argv - Raw CLI argv values after the executable name
 * @returns True when the invocation is asking for help
 */
export const isHelpInvocation = (argv: string[]): boolean =>
  argv.some((arg) => HELP_FLAGS.has(arg));
