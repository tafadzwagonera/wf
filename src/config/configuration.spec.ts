import configuration from './configuration';
import { normalizeWfConfig } from './wf-config-loader';

describe('configuration defaults', () => {
  afterEach(() => {
    delete process.env.WF_SKIP_CONFIG_BOOTSTRAP;
  });

  it('returns an empty config when help bootstrap skips preload', () => {
    process.env.WF_SKIP_CONFIG_BOOTSTRAP = 'true';

    expect(configuration()).toEqual({});
  });

  it('applies default logging level', () => {
    const config = normalizeWfConfig({});

    expect(config.logging.level).toBe('info');
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
