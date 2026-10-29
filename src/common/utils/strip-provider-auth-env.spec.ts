import { stripProviderAuthEnv } from './strip-provider-auth-env';

describe('stripProviderAuthEnv', () => {
  it('removes ANTHROPIC_API_KEY, OPENAI_API_KEY, and GEMINI_API_KEY', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-openai-test',
      GEMINI_API_KEY: 'gemini-test',
      PATH: '/usr/bin',
    };

    const result = stripProviderAuthEnv(env);

    expect(result).toStrictEqual({ PATH: '/usr/bin' });
  });

  it('leaves other environment variables untouched when no provider keys are present', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/bob' };

    const result = stripProviderAuthEnv(env);

    expect(result).toStrictEqual(env);
  });
});
