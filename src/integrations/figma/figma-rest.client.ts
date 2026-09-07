import { Injectable, Logger } from '@nestjs/common';

export interface FigmaFrameContext {
  url: string;
  screenshotUrl: string;
  name: string;
  width: number;
  height: number;
}

interface FigmaNodeDoc {
  name?: string;
  absoluteBoundingBox?: { width?: number; height?: number };
}

interface FigmaNodesResponse {
  nodes: Record<string, { document?: FigmaNodeDoc }>;
}

interface FigmaImagesResponse {
  images: Record<string, string>;
}

const FIGMA_API_BASE = 'https://api.figma.com';

function parseUrl(url: string): { fileKey: string; nodeId: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/');
  const keyIndex = segments.findIndex(s => s === 'file' || s === 'design');
  const fileKey = segments[keyIndex + 1] ?? '';
  const nodeId = parsed.searchParams.get('node-id') ?? '';
  return { fileKey, nodeId };
}

async function fetchJson<T>(req: RequestInfo, init: RequestInit): Promise<T> {
  const r = await fetch(req, init);
  if (!r.ok) throw new Error(`Figma API ${r.status}: ${r.url}`);
  return r.json() as Promise<T>;
}

async function fetchFrame(url: string, headers: Record<string, string>): Promise<FigmaFrameContext> {
  const { fileKey, nodeId } = parseUrl(url);
  const nodesUrl = `${FIGMA_API_BASE}/v1/files/${fileKey}/nodes?ids=${nodeId}`;
  const imagesUrl = `${FIGMA_API_BASE}/v1/images/${fileKey}?ids=${nodeId}&format=png&scale=2`;
  const { nodes } = await fetchJson<FigmaNodesResponse>(nodesUrl, { headers });
  const imagesRes = await fetchJson<FigmaImagesResponse>(imagesUrl, { headers });
  const doc = nodes[nodeId]?.document;
  return {
    url,
    name: doc?.name ?? '',
    width: doc?.absoluteBoundingBox?.width ?? 0,
    height: doc?.absoluteBoundingBox?.height ?? 0,
    screenshotUrl: imagesRes.images[nodeId] ?? '',
  };
}

async function attemptFetch(
  url: string, headers: Record<string, string>, logger: Logger
): Promise<FigmaFrameContext | undefined> {
  try {
    return await fetchFrame(url, headers);
  } catch (err) {
    logger.warn(`Figma frame fetch failed for ${url}: ${(err as Error).message}`);
    return undefined;
  }
}

@Injectable()
export class FigmaRestClient {
  private readonly logger = new Logger(FigmaRestClient.name);

  async fetchFrames(urls: string[]): Promise<FigmaFrameContext[]> {
    const token = process.env.FIGMA_TOKEN;
    if (!token) {
      if (urls.length) this.logger.warn('FIGMA_TOKEN not set — Figma frame fetch skipped');
      return [];
    }
    const headers = { 'X-Figma-Token': token };
    const results: FigmaFrameContext[] = [];
    for (const url of urls) {
      const frame = await attemptFetch(url, headers, this.logger);
      if (frame) results.push(frame);
    }
    return results;
  }
}
