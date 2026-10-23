import * as fs from 'fs';
import * as path from 'path';
import { createTempDir as createManagedTempDir } from '../common/testing/temp-dir';
import { ValidationError } from '../common/utils/errors';
import { loadTypeScriptConfig } from './wf-config-loader';

jest.mock('../common/utils/runtime-assets', () => ({
  ...jest.requireActual('../common/utils/runtime-assets'),
  isSeaRuntime: jest.fn(() => true),
}));

describe('loadTypeScriptConfig inside a SEA binary without bundled jiti', () => {
  const projectRoot = createManagedTempDir('config-sea-missing');
  const configPath = path.join(projectRoot, 'wf.config.ts');

  beforeAll(() => {
    fs.writeFileSync(configPath, 'export default {};\n');
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails loudly with a ValidationError naming the missing bundled jiti', async () => {
    const load = loadTypeScriptConfig(configPath, {
      cwd: projectRoot,
      runtime: 'node',
      nodeVersion: '22.12.0',
      execArgv: [],
    });

    await expect(load).rejects.toThrow(/Bundled jiti is not registered/);
    await expect(load).rejects.toBeInstanceOf(ValidationError);
  });
});
