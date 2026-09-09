import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FigmaFrameContext, FigmaNodeLayout, FigmaRestClient } from './figma-rest.client';

const DESIGN_URL_K1 = 'https://www.figma.com/design/K1/File?node-id=1-1';
const DESIGN_URL_K2 = 'https://www.figma.com/design/K2/File?node-id=1-1';
const DESIGN_URL = 'https://www.figma.com/design/ABC123/MyFile?node-id=1-2';

function makeNodesResponse(
  nodeId: string,
  name: string,
  width: number,
  height: number,
  extraDoc: Record<string, unknown> = {}
) {
  return {
    ok: true,
    json: async () => ({
      nodes: {
        [nodeId]: { document: { name, absoluteBoundingBox: { width, height }, ...extraDoc } },
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
  afterEach(() => {
    jest.restoreAllMocks();
    mockConfigService.get.mockReturnValue(undefined);
  });

  describe('fetchFrames', () => {
    it('parses design URL, calls nodes then images endpoint with X-Figma-Token header, returns FigmaFrameContext', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'test-token' : undefined);
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
        layout: { name: 'Hero Frame', width: 1440, height: 900 },
      };
      expect(result).toEqual([expectedFrame]);
      expect(mockFetch.mock.calls[0][1]).toMatchObject({
        headers: { 'X-Figma-Token': 'test-token' },
      });
      expect(String(mockFetch.mock.calls[0][0])).toContain('/v1/files/ABC123/nodes?ids=1-2');
      expect(String(mockFetch.mock.calls[1][0])).toContain('/v1/images/ABC123?ids=1-2&format=png&scale=2');
    });

    it('extracts layout properties including fills, padding, gap, and children from the Nodes API response', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'tok' : undefined);
      const client = await buildClient();
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeNodesResponse('1-2', 'Card', 360, 240, {
          type: 'FRAME',
          layoutMode: 'VERTICAL',
          primaryAxisAlignItems: 'MIN',
          paddingTop: 16,
          paddingRight: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          itemSpacing: 8,
          cornerRadius: 4,
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
          children: [
            {
              name: 'Label',
              type: 'TEXT',
              absoluteBoundingBox: { width: 328, height: 20 },
              characters: 'Hello world',
              style: { fontSize: 14, fontWeight: 600, lineHeightPx: 20 },
            },
          ],
        }))
        .mockResolvedValueOnce(makeImagesResponse('1-2', 'https://s3.example.com/card.png'));

      const [frame] = await client.fetchFrames([DESIGN_URL]);

      const expected: FigmaNodeLayout = {
        name: 'Card',
        type: 'FRAME',
        width: 360,
        height: 240,
        layoutMode: 'VERTICAL',
        primaryAxisAlign: 'MIN',
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        gap: 8,
        cornerRadius: 4,
        fills: [{ type: 'SOLID', hex: '#ffffff' }],
        children: [
          {
            name: 'Label',
            type: 'TEXT',
            width: 328,
            height: 20,
            text: 'Hello world',
            typography: { fontSize: 14, fontWeight: 600, lineHeightPx: 20, textDecoration: undefined },
          },
        ],
      };
      expect(frame.layout).toEqual(expected);
    });

    it('omits layoutMode when value is NONE', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'tok' : undefined);
      const client = await buildClient();
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeNodesResponse('1-2', 'Static', 100, 100, { layoutMode: 'NONE' }))
        .mockResolvedValueOnce(makeImagesResponse('1-2', 'https://img'));

      const [frame] = await client.fetchFrames([DESIGN_URL]);

      expect(frame.layout.layoutMode).toBeUndefined();
    });

    it('fetches URLs sequentially — K1 requests precede K2 requests', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'tok' : undefined);
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

    it('returns [] when figma.token is not configured', async () => {
      const client = await buildClient();

      const result = await client.fetchFrames([DESIGN_URL]);

      expect(result).toEqual([]);
    });

    it('uses figma.token from config', async () => {
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'figma.token' ? 'config-token' : undefined
      );
      const client = await buildClient();
      const fetchSpy = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeNodesResponse('1-2', 'Frame', 800, 600))
        .mockResolvedValueOnce(makeImagesResponse('1-2', 'https://img.example.com/f.png'));

      await client.fetchFrames([DESIGN_URL]);

      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: { 'X-Figma-Token': 'config-token' },
      });
    });

    it('skips a URL that has no node-id query param and returns []', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'test-token' : undefined);
      const client = await buildClient();
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
        throw new Error('fetch should not be called');
      });

      const result = await client.fetchFrames([
        'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed',
      ]);

      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips a URL and returns [] when the Figma API responds with a non-2xx status', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'test-token' : undefined);
      const client = await buildClient();
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ err: 'Unauthorized' }),
      } as unknown as Response);

      const result = await client.fetchFrames([DESIGN_URL]);

      expect(result).toEqual([]);
    });

    it('includes Retry-After, plan tier, and limit-type in the WARN when the API returns 429', async () => {
      mockConfigService.get.mockImplementation((key: string) => key === 'figma.token' ? 'test-token' : undefined);
      const client = await buildClient();
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        url: 'https://api.figma.com/v1/files/ABC123/nodes?ids=1-2',
        headers: {
          get: (name: string) => ({
            'Retry-After': '3600',
            'X-Figma-Plan-Tier': 'free',
            'X-Figma-Rate-Limit-Type': 'low',
          }[name] ?? null),
        },
        json: async () => ({ status: 429, err: 'Rate limit exceeded' }),
      } as unknown as Response);
      const { Logger } = jest.requireActual('@nestjs/common');
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      const result = await client.fetchFrames([DESIGN_URL]);

      expect(result).toEqual([]);
      const warnText = warnSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(warnText).toMatch(/retry-after=3600s/);
      expect(warnText).toMatch(/plan=free/);
      expect(warnText).toMatch(/limit-type=low/);
    });
  });
});
