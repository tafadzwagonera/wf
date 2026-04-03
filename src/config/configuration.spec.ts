import configuration from './configuration';
import { normalizeWfConfig } from './wf-config-loader';
import * as os from 'os';
import * as path from 'path';

describe('configuration defaults', () => {
  afterEach(() => {
    delete process.env.WF_SKIP_CONFIG_BOOTSTRAP;
  });

  it('returns an empty config when help bootstrap skips preload', () => {
    process.env.WF_SKIP_CONFIG_BOOTSTRAP = 'true';

    expect(configuration()).toEqual({});
  });

  it('uses home-scoped defaults for state and logging directories', () => {
    const config = configuration();

    expect(config.state.directory).toBe(
      path.join(os.homedir(), '.wf', 'state'),
    );
    expect(config.logging.directory).toBe(
      path.join(os.homedir(), '.wf', 'logs'),
    );
  });

  it('applies normalized defaults for state and logging directories', () => {
    const config = normalizeWfConfig({});

    expect(config.state.directory).toBe(
      path.join(os.homedir(), '.wf', 'state'),
    );
    expect(config.logging.directory).toBe(
      path.join(os.homedir(), '.wf', 'logs'),
    );
  });

  it('normalizes relative config overrides into the wf home directory', () => {
    const config = normalizeWfConfig({
      state: { directory: '.wf/state' },
      log: { directory: '.wf/logs' },
    });

    expect(config.state.directory).toBe(
      path.join(os.homedir(), '.wf', 'state'),
    );
    expect(config.logging.directory).toBe(
      path.join(os.homedir(), '.wf', 'logs'),
    );
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
