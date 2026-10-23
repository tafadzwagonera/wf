import { buildCliArgs } from './claude-cli-runner';
import { extractRuntimeAsset, isSeaRuntime } from '../../../common/utils/runtime-assets';

jest.mock('../../../common/utils/runtime-assets', () => ({
  extractRuntimeAsset: jest.fn(),
  isSeaRuntime: jest.fn(),
}));

describe('buildCliArgs MCP config path', () => {
  const mockIsSeaRuntime = isSeaRuntime as jest.Mock;
  const mockExtractRuntimeAsset = extractRuntimeAsset as jest.Mock;
  const params = { prompt: 'p', model: 'claude-sonnet-4-6', cwd: '/repo' };

  afterEach(() => {
    jest.restoreAllMocks();
    mockIsSeaRuntime.mockReset();
    mockExtractRuntimeAsset.mockReset();
  });

  it('passes the extracted no-mcp.json path as --mcp-config in a SEA binary', () => {
    mockIsSeaRuntime.mockReturnValue(true);
    mockExtractRuntimeAsset.mockReturnValue('/home/u/.wf/bin/no-mcp.json');

    const args = buildCliArgs(params);

    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/home/u/.wf/bin/no-mcp.json');
    expect(mockExtractRuntimeAsset).toHaveBeenCalledTimes(1);
    const [extractParams] = mockExtractRuntimeAsset.mock.calls[0];
    expect(extractParams.assetKey).toBe('no-mcp.json');
    expect(extractParams.destPath).toMatch(/\.wf[\\/]bin[\\/]no-mcp\.json$/);
  });

  it('passes the on-disk bootstrap no-mcp.json path outside a SEA binary', () => {
    mockIsSeaRuntime.mockReturnValue(false);

    const args = buildCliArgs(params);

    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/bootstrap[\\/]no-mcp\.json$/);
    expect(mockExtractRuntimeAsset).not.toHaveBeenCalled();
  });
});
