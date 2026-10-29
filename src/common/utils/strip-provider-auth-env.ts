const providerAuthEnvKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

export const stripProviderAuthEnv = <T extends Record<string, string | undefined>>(env: T): T => {
  const result = { ...env };
  for (const key of providerAuthEnvKeys) delete result[key];
  return result;
};
