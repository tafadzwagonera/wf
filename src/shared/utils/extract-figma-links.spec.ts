import { extractFigmaLinks, searchFigmaLinksForTicket } from './extract-figma-links';

describe('extractFigmaLinks', () => {
  it('returns a matching figma.com/design URL', () => {
    const text = 'Design at https://www.figma.com/design/abc123/My-Page?node-id=1';
    expect(extractFigmaLinks(text)).toEqual(['https://www.figma.com/design/abc123/My-Page']);
  });

  it('returns empty array when no figma URL is present', () => {
    expect(extractFigmaLinks('no links here')).toEqual([]);
  });

  it('returns all figma URLs when multiple are present', () => {
    const text = 'https://figma.com/design/A/X and https://figma.com/file/B/Y';
    expect(extractFigmaLinks(text)).toHaveLength(2);
  });

  it('does not return non-figma URLs', () => {
    expect(extractFigmaLinks('https://example.com/design/abc')).toEqual([]);
  });
});

describe('searchFigmaLinksForTicket', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns links from ticket content when present', async () => {
    const content = 'See https://figma.com/design/abc/Page for reference.';
    const result = await searchFigmaLinksForTicket(content, false);
    expect(result).toEqual(['https://figma.com/design/abc/Page']);
  });

  it('returns empty array when no links and allowPrompt is false', async () => {
    const result = await searchFigmaLinksForTicket('no links here', false);
    expect(result).toEqual([]);
  });
});
