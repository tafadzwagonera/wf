import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FigmaFrameContext, FigmaRestClient } from './figma-rest.client';

const DESIGN_URL_K1 = 'https://www.figma.com/design/K1/File?node-id=1-1';
const DESIGN_URL_K2 = 'https://www.figma.com/design/K2/File?node-id=1-1';
const DESIGN_URL = 'https://www.figma.com/design/ABC123/MyFile?node-id=1-2';

function makeNodesResponse(nodeId: string, name: string, width: number, height: number) {
  return {
    ok: true,
    json: async () => ({
      nodes: {
        [nodeId]: { document: { name, absoluteBoundingBox: { width, height } } },
      },
    }),
  } as unknown as Response;
}

function makeImagesResponse(nodeId: string, screenshotUrl: string) {
  return {
    ok: true,
    json: async () => ({ images: { [nodeId]: screenshotUrl } }),
  } as unknown as Response;
}

const mockConfigService = { get: jest.fn().mockReturnValue(undefined) };

async function buildClient() {
  const module = await Test.createTestingModule({
    providers: [
      FigmaRestClient,
      { provide: ConfigService, useValue: mockConfigService },
    ],
  }).compile();
  return module.get(FigmaRestClient);
}

describe('FigmaRestClient', () => {
  beforeEach(() => {
    process.env.FIGMA_TOKEN = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockConfigService.get.mockReturnValue(undefined);
    delete process.env.FIGMA_TOKEN;
  });

  describe('fetchFrames', () => {
    it('parses design URL, calls nodes then images endpoint with X-Figma-Token header, returns FigmaFrameContext', async () => {
      jest.replaceProperty(process.env, 'FIGMA_TOKEN', 'test-token');
      const client = await buildClient();
      const mockFetch = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeNodesResponse('1-2', 'Hero Frame', 1440, 900))
        .mockResolvedValueOnce(makeImagesResponse('1-2', 'https://s3.example.com/hero.png'));

      const result = await client.fetchFrames([DESIGN_URL]);

      const expectedFrame: FigmaFrameContext = {
        url: DESIGN_URL,
        name: 'Hero Frame',
        width: 1440,
        height: 900,
        screenshotUrl: 'https://s3.example.com/hero.png',
      };
      expect(result).toEqual([expectedFrame]);
      expect(mockFetch.mock.calls[0][1]).toMatchObject({
        headers: { 'X-Figma-Token': 'test-token' },
      });
      expect(String(mockFetch.mock.calls[0][0])).toContain('/v1/files/ABC123/nodes?ids=1-2');
      expect(String(mockFetch.mock.calls[1][0])).toContain('/v1/images/ABC123?ids=1-2&format=png&scale=2');
    });

    it('fetches URLs sequentially — K1 requests precede K2 requests', async () => {
      jest.replaceProperty(process.env, 'FIGMA_TOKEN', 'tok');
      const client = await buildClient();
      const callOrder: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation(async url => {
        const urlStr = String(url);
        callOrder.push(urlStr);
        const fileKey = urlStr.includes('K1') ? 'K1' : 'K2';
        const nodeId = '1-1';
        if (urlStr.includes('/nodes')) return makeNodesResponse(nodeId, 'F', 100, 100);
        return makeImagesResponse(nodeId, 'https://img/' + fileKey);
      });

      await client.fetchFrames([DESIGN_URL_K1, DESIGN_URL_K2]);

      const firstK1 = callOrder.findIndex(u => u.includes('K1'));
      const firstK2 = callOrder.findIndex(u => u.includes('K2'));
      expect(firstK1).toBeLessThan(firstK2);
    });

    it('returns [] and does not throw when FIGMA_TOKEN is absent', async () => {
      jest.replaceProperty(process.env, 'FIGMA_TOKEN', '');
      const client = await buildClient();

      const result = await client.fetchFrames([DESIGN_URL]);

      expect(result).toEqual([]);
    });

    it('uses figma.token from config when set, falling back to FIGMA_TOKEN env var', async () => {
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'figma.token' ? 'config-token' : undefined
      );
      const client = await buildClient();
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeNodesResponse('1-2', 'Frame', 800, 600))
        .mockResolvedValueOnce(makeImagesResponse('1-2', 'https://img.example.com/f.png'));

      await client.fetchFrames([DESIGN_URL]);

      expect(jest.spyOn(global, 'fetch').mock.calls[0]?.[1]).toMatchObject({
        headers: { 'X-Figma-Token': 'config-token' },
      });
    });

    it('skips a URL and returns [] when the Figma API responds with a non-2xx status', async () => {
      jest.replaceProperty(process.env, 'FIGMA_TOKEN', 'test-token');
      const client = await buildClient();
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ err: 'Unauthorized' }),
      } as unknown as Response);

      const result = await client.fetchFrames([DESIGN_URL]);

      expect(result).toEqual([]);
    });
  });
});
