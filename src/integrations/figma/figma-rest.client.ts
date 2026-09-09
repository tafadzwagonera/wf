import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ERROR_CODE, ValidationError } from '../../shared/utils/errors';

export interface FigmaFillContext {
  type: string;
  hex?: string;
}

export interface FigmaTypographyContext {
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  textDecoration?: string;
}

export interface FigmaNodeLayout {
  name: string;
  type?: string;
  width?: number;
  height?: number;
  layoutMode?: string;
  primaryAxisAlign?: string;
  counterAxisAlign?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  gap?: number;
  cornerRadius?: number;
  fills?: FigmaFillContext[];
  typography?: FigmaTypographyContext;
  text?: string;
  children?: FigmaNodeLayout[];
}

export interface FigmaFrameContext {
  url: string;
  screenshotUrl: string;
  name: string;
  width: number;
  height: number;
  layout: FigmaNodeLayout;
}

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface FigmaFill {
  type: string;
  color?: FigmaColor;
}

interface FigmaNodeStyle {
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  textDecoration?: string;
}

interface FigmaNodeDoc {
  name?: string;
  type?: string;
  absoluteBoundingBox?: { width?: number; height?: number };
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  cornerRadius?: number;
  fills?: FigmaFill[];
  style?: FigmaNodeStyle;
  characters?: string;
  children?: FigmaNodeDoc[];
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
  const nodeId = parsed.searchParams.get('node-id');
  if (!nodeId) throw new ValidationError(`Missing node-id query param in Figma URL: ${url}`);
  return { fileKey, nodeId };
}

async function fetchJson<T>(req: RequestInfo, init: RequestInit): Promise<T> {
  const r = await fetch(req, init);
  if (!r.ok) {
    if (r.status === 429) {
      const retryAfter = r.headers.get('Retry-After');
      const planTier = r.headers.get('X-Figma-Plan-Tier');
      const limitType = r.headers.get('X-Figma-Rate-Limit-Type');
      const detail = [
        retryAfter ? `retry-after=${retryAfter}s` : null,
        planTier ? `plan=${planTier}` : null,
        limitType ? `limit-type=${limitType}` : null,
      ].filter(Boolean).join(' ');
      throw new ApiError(
        ERROR_CODE.FIGMA_API_ERROR,
        `Figma API rate-limited${detail ? ` (${detail})` : ''}`,
        429,
        String(r.url),
      );
    }
    throw new ApiError(ERROR_CODE.FIGMA_API_ERROR, `Figma API error`, r.status, String(r.url));
  }
  return r.json() as Promise<T>;
}

function toHex(color: FigmaColor): string {
  return '#' + [color.r, color.g, color.b]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
    .join('');
}

function extractNodeLayout(doc: FigmaNodeDoc): FigmaNodeLayout {
  const bbox = doc.absoluteBoundingBox;
  const fills: FigmaFillContext[] = (doc.fills ?? [])
    .filter(f => f.type === 'SOLID' && f.color)
    .map(f => ({ type: f.type, hex: f.color ? toHex(f.color) : undefined }));
  const s = doc.style;
  const typography: FigmaTypographyContext | undefined = s
    ? { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeightPx: s.lineHeightPx, textDecoration: s.textDecoration }
    : undefined;
  const hasTypo = typography && Object.values(typography).some(v => v !== undefined);

  const node: FigmaNodeLayout = { name: doc.name ?? '' };
  if (doc.type !== undefined) node.type = doc.type;
  if (bbox?.width !== undefined) node.width = bbox.width;
  if (bbox?.height !== undefined) node.height = bbox.height;
  if (doc.layoutMode && doc.layoutMode !== 'NONE') node.layoutMode = doc.layoutMode;
  if (doc.primaryAxisAlignItems) node.primaryAxisAlign = doc.primaryAxisAlignItems;
  if (doc.counterAxisAlignItems) node.counterAxisAlign = doc.counterAxisAlignItems;
  if (doc.paddingTop !== undefined) node.paddingTop = doc.paddingTop;
  if (doc.paddingRight !== undefined) node.paddingRight = doc.paddingRight;
  if (doc.paddingBottom !== undefined) node.paddingBottom = doc.paddingBottom;
  if (doc.paddingLeft !== undefined) node.paddingLeft = doc.paddingLeft;
  if (doc.itemSpacing !== undefined) node.gap = doc.itemSpacing;
  if (doc.cornerRadius !== undefined) node.cornerRadius = doc.cornerRadius;
  if (fills.length) node.fills = fills;
  if (hasTypo) node.typography = typography;
  if (doc.characters) node.text = doc.characters;
  if (doc.children?.length) node.children = doc.children.map(extractNodeLayout);
  return node;
}

async function fetchFrame(url: string, headers: Record<string, string>): Promise<FigmaFrameContext> {
  const { fileKey, nodeId } = parseUrl(url);
  const nodesUrl = `${FIGMA_API_BASE}/v1/files/${fileKey}/nodes?ids=${nodeId}`;
  const imagesUrl = `${FIGMA_API_BASE}/v1/images/${fileKey}?ids=${nodeId}&format=png&scale=2`;
  const { nodes } = await fetchJson<FigmaNodesResponse>(nodesUrl, { headers });
  const imagesRes = await fetchJson<FigmaImagesResponse>(imagesUrl, { headers });
  const doc = nodes[nodeId]?.document ?? {};
  return {
    url,
    name: doc.name ?? '',
    width: doc.absoluteBoundingBox?.width ?? 0,
    height: doc.absoluteBoundingBox?.height ?? 0,
    screenshotUrl: imagesRes.images[nodeId] ?? '',
    layout: extractNodeLayout(doc),
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

  constructor(private readonly configService: ConfigService) {}

  async fetchFrames(urls: string[]): Promise<FigmaFrameContext[]> {
    const token = this.configService.get<string>('figma.token');
    if (!token) {
      if (urls.length) this.logger.warn('figma.token not configured — Figma frame fetch skipped');
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
