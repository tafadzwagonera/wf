let originalEnv: NodeJS.ProcessEnv | undefined;

/**
 * Replaces `process.env` for a test with the provided overrides.
 *
 * Works under both Jest and plain ts-node (manual smoke tests), so it must never
 * call Jest APIs or register hooks. Repeated calls accumulate overrides;
 * `restoreEnv` always returns to the environment seen by the first call.
 *
 * @param overrides - Environment values to add, update, or remove (`undefined` removes).
 */
export const withEnv = (overrides: Record<string, string | undefined>): void => {
  const nextEnv = { ...process.env };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete nextEnv[key];
      continue;
    }

    nextEnv[key] = value;
  }

  originalEnv ??= process.env;
  process.env = nextEnv;
};

/** Restores `process.env` after `withEnv()` usage. Safe to call unconditionally. */
export const restoreEnv = (): void => {
  if (originalEnv !== undefined) process.env = originalEnv;
  originalEnv = undefined;
};
