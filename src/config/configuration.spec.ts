import configuration from './configuration';
import { normalizeWfConfig } from './wf-config-loader';
import { restoreEnv, withEnv } from '../common/testing/env';

describe('configuration defaults', () => {
  beforeEach(() => withEnv({ WF_SKIP_CONFIG_BOOTSTRAP: undefined }));

  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('returns an empty config when help bootstrap skips preload', () => {
    withEnv({ WF_SKIP_CONFIG_BOOTSTRAP: 'true' });

    expect(configuration()).toEqual({});
  });

  it('applies default logging level', () => {
    const config = normalizeWfConfig({});

    expect(config.logging.level).toBe('info');
  });

  it('preserves configured protected branches', () => {
    const config = normalizeWfConfig({ git: { protectedBranches: ['main', 'release'] } });

    expect(config.git.protectedBranches).toEqual(['main', 'release']);
  });

  it('preserves configured Slack user token settings', () => {
    const config = normalizeWfConfig({
      slack: {
        botToken: 'xoxb-test-token',
        userToken: 'xoxp-test-token',
      },
    });

    expect(config.slack.botToken).toBe('xoxb-test-token');
    expect(config.slack.userToken).toBe('xoxp-test-token');
  });
});
