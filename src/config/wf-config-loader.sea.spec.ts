import * as fs from 'fs';
import * as path from 'path';
import { lazyModuleKey, registerLazyModule } from '../bootstrap/lazy-module';
import { createTempDir as createManagedTempDir } from '../common/testing/temp-dir';
import { loadTypeScriptConfig } from './wf-config-loader';

jest.mock('../common/utils/runtime-assets', () => ({
  ...jest.requireActual('../common/utils/runtime-assets'),
  isSeaRuntime: jest.fn(() => true),
}));

describe('loadTypeScriptConfig inside a SEA binary', () => {
  const projectRoot = createManagedTempDir('config-sea');
  const configPath = path.join(projectRoot, 'wf.config.ts');
  const loadOptions = { cwd: projectRoot, runtime: 'node' as const, nodeVersion: '22.12.0', execArgv: [] };

  beforeAll(() => {
    fs.writeFileSync(configPath, 'export default {};\n');
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the config through the bundled jiti created for the project cwd', async () => {
    const mockLoadModule = jest.fn().mockReturnValue({
      __esModule: true,
      default: { ai: [{ provider: 'openai', apiKey: 'sea-key', model: 'gpt-5.4' }] },
    });
    const mockCreateJiti = jest.fn().mockReturnValue(mockLoadModule);
    registerLazyModule(lazyModuleKey.jiti, mockCreateJiti);

    const config = await loadTypeScriptConfig(configPath, loadOptions);

    expect(config).toEqual({ ai: [{ provider: 'openai', apiKey: 'sea-key', model: 'gpt-5.4' }] });
    expect(mockCreateJiti).toHaveBeenCalledTimes(1);
    expect(mockCreateJiti.mock.calls[0]).toEqual([projectRoot]);
    expect(mockLoadModule).toHaveBeenCalledTimes(1);
    expect(mockLoadModule.mock.calls[0]).toEqual([configPath]);
  });

  it('prefers an explicitly provided loadJiti over the bundled one', async () => {
    const mockCreateJiti = jest.fn();
    registerLazyModule(lazyModuleKey.jiti, mockCreateJiti);

    const config = await loadTypeScriptConfig(configPath, {
      ...loadOptions,
      loadJiti: () => ({ __esModule: true, default: { ai: [] } }),
    });

    expect(config).toEqual({ ai: [] });
    expect(mockCreateJiti).not.toHaveBeenCalled();
  });
});
