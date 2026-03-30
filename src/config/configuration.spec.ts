import configuration from './configuration';
import { validationSchema } from './validation.schema';
import * as os from 'os';
import * as path from 'path';

describe('configuration defaults', () => {
  const originalStateDirectory = process.env.STATE_DIRECTORY;
  const originalLogDirectory = process.env.LOG_DIRECTORY;

  afterEach(() => {
    if (originalStateDirectory === undefined) {
      delete process.env.STATE_DIRECTORY;
    } else {
      process.env.STATE_DIRECTORY = originalStateDirectory;
    }

    if (originalLogDirectory === undefined) {
      delete process.env.LOG_DIRECTORY;
    } else {
      process.env.LOG_DIRECTORY = originalLogDirectory;
    }
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

  it('aligns validation defaults for state and logging directories', () => {
    const { value, error } = validationSchema.validate({});

    expect(error).toBeUndefined();
    expect(value.STATE_DIRECTORY).toBe(path.join(os.homedir(), '.wf', 'state'));
    expect(value.LOG_DIRECTORY).toBe(path.join(os.homedir(), '.wf', 'logs'));
  });

  it('normalizes relative env overrides into the wf home directory', () => {
    process.env.STATE_DIRECTORY = '.wf/state';
    process.env.LOG_DIRECTORY = '.wf/logs';

    const config = configuration();

    expect(config.state.directory).toBe(path.join(os.homedir(), '.wf', 'state'));
    expect(config.logging.directory).toBe(
      path.join(os.homedir(), '.wf', 'logs'),
    );
  });
});
