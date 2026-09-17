import {
  formatUiDesignScreenshotsPlanPromptSection,
  buildUiDesignComplianceSystemPromptSection,
  planFileListingInstructions,
} from './prompt-fragments';

describe('formatUiDesignScreenshotsPlanPromptSection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty string for empty paths array', () => {
    expect(formatUiDesignScreenshotsPlanPromptSection([])).toBe('');
  });

  it('lists basenames and includes injection note', () => {
    const result = formatUiDesignScreenshotsPlanPromptSection(['/abs/path/design.png']);
    expect(result).toContain('design.png');
    expect(result).toContain('injected as images');
  });

  it('includes all basenames when multiple paths provided', () => {
    const result = formatUiDesignScreenshotsPlanPromptSection(['/a/header.png', '/b/footer.jpg']);
    expect(result).toContain('header.png');
    expect(result).toContain('footer.jpg');
  });
});

describe('buildUiDesignComplianceSystemPromptSection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty string when both arrays are empty', () => {
    expect(buildUiDesignComplianceSystemPromptSection({ figmaLinks: [], uiDesignScreenshots: [] })).toBe('');
  });

  it('returns empty string when both are omitted', () => {
    expect(buildUiDesignComplianceSystemPromptSection({})).toBe('');
  });

  it('returns compliance block when figmaLinks present', () => {
    const result = buildUiDesignComplianceSystemPromptSection({ figmaLinks: ['https://figma.com/x'] });
    expect(result).toContain('UI design compliance');
  });

  it('returns compliance block when uiDesignScreenshots present', () => {
    const result = buildUiDesignComplianceSystemPromptSection({ uiDesignScreenshots: ['/a/b.png'] });
    expect(result).toContain('UI design compliance');
  });
});

describe('planFileListingInstructions', () => {
  it('defines complexity using targeted writes from affectedFiles and step count', () => {
    expect(planFileListingInstructions).toContain('targeted writes');
    expect(planFileListingInstructions).toContain('affectedFiles');
    expect(planFileListingInstructions).toContain('affectedFilesContext');
    expect(planFileListingInstructions).toContain('plan step count');
    expect(planFileListingInstructions).toContain('low complexity');
  });
});
