import { extractFigmaLinks, resolvePostParseFigmaLinks, searchFigmaLinksForTicket } from './extract-figma-links';
import inquirer from 'inquirer';
import { detectRepoConventions } from './detect-repo-conventions';

jest.mock('./detect-repo-conventions');

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
