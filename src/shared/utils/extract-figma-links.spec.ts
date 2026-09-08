import { extractFigmaLinks, resolvePostParseFigmaLinks, searchFigmaLinksForTicket } from './extract-figma-links';
import inquirer from 'inquirer';
import { detectRepoConventions } from './detect-repo-conventions';

jest.mock('./detect-repo-conventions');

describe('extractFigmaLinks', () => {
  it('returns a matching figma.com/design URL', () => {
    const text = 'Design at https://www.figma.com/design/abc123/My-Page?node-id=1';
    expect(extractFigmaLinks(text)).toEqual(['https://www.figma.com/design/abc123/My-Page?node-id=1']);
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

  it('returns a matching figma.com/proto URL', () => {
    const text = 'Prototype at https://www.figma.com/proto/AbC123XyZ/Stories-Feed?node-id=12-34';
    expect(extractFigmaLinks(text)).toEqual(['https://www.figma.com/proto/AbC123XyZ/Stories-Feed?node-id=12-34']);
  });

  it('returns a matching figma.com/board URL', () => {
    const text = 'Board at https://www.figma.com/board/AbC123XyZ/Stories-Brainstorm';
    expect(extractFigmaLinks(text)).toEqual(['https://www.figma.com/board/AbC123XyZ/Stories-Brainstorm']);
  });

  it('preserves both distinct node-id params when two links on the same file differ only by ?node-id', () => {
    const urlA = 'https://figma.com/design/abc123/Page?node-id=17-4';
    const urlB = 'https://figma.com/design/abc123/Page?node-id=30-10616';
    const result = extractFigmaLinks(`Desktop: ${urlA} Mobile: ${urlB}`);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(urlA);
    expect(result[1]).toBe(urlB);
  });

  it('excludes trailing prose punctuation (comma, period, closing-paren) without dropping the query string', () => {
    expect(extractFigmaLinks('See https://figma.com/design/abc/Page?node-id=1-2, done.')).toEqual([
      'https://figma.com/design/abc/Page?node-id=1-2',
    ]);
    expect(extractFigmaLinks('End of sentence https://figma.com/design/abc/Page?node-id=1-2. See above.')).toEqual([
      'https://figma.com/design/abc/Page?node-id=1-2',
    ]);
    expect(extractFigmaLinks('(https://figma.com/design/abc/Page?node-id=1-2)')).toEqual([
      'https://figma.com/design/abc/Page?node-id=1-2',
    ]);
  });

  it('preserves a query string that contains multiple params joined by &', () => {
    const text = 'See https://figma.com/design/abc/Page?node-id=1-2&t=abc123 here';
    expect(extractFigmaLinks(text)).toEqual([
      'https://figma.com/design/abc/Page?node-id=1-2&t=abc123',
    ]);
  });

  it('does not fold a prose ? immediately after the URL into the query string', () => {
    const text = 'Did you see https://figma.com/design/abc/Page?node-id=1-2? Yes.';
    expect(extractFigmaLinks(text)).toEqual([
      'https://figma.com/design/abc/Page?node-id=1-2',
    ]);
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

describe('resolvePostParseFigmaLinks', () => {
  let mockDetectRepoConventions: jest.MockedFunction<typeof detectRepoConventions>;
  let mockInquirerPrompt: jest.SpyInstance;

  beforeEach(() => {
    mockDetectRepoConventions = detectRepoConventions as jest.MockedFunction<typeof detectRepoConventions>;
    mockDetectRepoConventions.mockReturnValue({ designSystem: { hasUiEnvironment: false } } as any);
    mockInquirerPrompt = jest.spyOn(inquirer, 'prompt').mockResolvedValue({ input: '' } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns autoLinks immediately when non-empty, without calling detectRepoConventions', async () => {
    const result = await resolvePostParseFigmaLinks(
      'some content',
      ['https://figma.com/design/X/Y'],
      { allowPrompt: false, repoDir: '/repo' }
    );
    expect(result).toEqual(['https://figma.com/design/X/Y']);
    expect(mockDetectRepoConventions).not.toHaveBeenCalled();
  });

  it('calls detectRepoConventions with repoDir when conventions is omitted', async () => {
    await resolvePostParseFigmaLinks('no links', [], { allowPrompt: false, repoDir: '/my/repo' });
    expect(mockDetectRepoConventions).toHaveBeenCalledWith('/my/repo');
  });

  it('returns links from content when designSystem.hasUiEnvironment is true', async () => {
    const result = await resolvePostParseFigmaLinks(
      'See https://figma.com/design/abc/Screen for reference.',
      [],
      { allowPrompt: false, conventions: { designSystem: { hasUiEnvironment: true } } }
    );
    expect(result).toEqual(['https://figma.com/design/abc/Screen']);
  });

  it('does not invoke inquirer when designSystem.hasUiEnvironment is false, even with TTY active', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const result = await resolvePostParseFigmaLinks('no links', [], {
      allowPrompt: true,
      conventions: { designSystem: { hasUiEnvironment: false } },
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    expect(result).toEqual([]);
    expect(mockInquirerPrompt).not.toHaveBeenCalled();
  });

  it('returns empty array when conventions.designSystem is undefined', async () => {
    const result = await resolvePostParseFigmaLinks('no links', [], {
      allowPrompt: false,
      conventions: { designSystem: undefined },
    });
    expect(result).toEqual([]);
  });
});
