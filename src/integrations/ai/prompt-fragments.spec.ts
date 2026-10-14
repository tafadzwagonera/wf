import {
  formatUiDesignScreenshotsPlanPromptSection,
  buildUiDesignComplianceSystemPromptSection,
  planFileListingInstructions,
  planStepPrinciples,
  implementerSearchRule,
  implementerDeleteOrphanRule,
  needleSearchReminder,
} from './prompt-fragments';

describe('planStepPrinciples', () => {
  it('directs commands to verification.targeted and forbids hand-off steps', () => {
    expect(planStepPrinciples).toContain('verification.targeted');
    expect(planStepPrinciples).toContain('Do not write plan steps that run verification commands');
  });

  it('no longer asks for staged-state verification before handoff', () => {
    expect(planStepPrinciples).not.toContain('staged state before handoff');
  });

  it('keeps the first principle bullet intact', () => {
    expect(planStepPrinciples).toContain('Be explicit about before and after');
  });

  it('includes the failure-mode principle for guardrails and fallbacks', () => {
    expect(planStepPrinciples).toContain('empty or failed input');
  });
});

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
  it('asks for risk severity and does not ask the model to estimate complexity', () => {
    expect(planFileListingInstructions).toContain('"severity" (low/medium/high)');
    expect(planFileListingInstructions).toContain('do not estimate complexity yourself');
    expect(planFileListingInstructions).not.toContain('Estimated complexity');
  });
});

describe('needle search rules', () => {
  it('puts the case-insensitive whole-repository search rule and .gitignore note in the planner prompt', () => {
    expect(planStepPrinciples).toContain(implementerSearchRule);
    expect(planStepPrinciples).toContain('git grep --no-index');
    expect(implementerSearchRule).toContain('case-insensitive');
    expect(implementerSearchRule).toContain('whole repository');
  });

  it('names the given search tool in the delete-orphan rule', () => {
    expect(implementerDeleteOrphanRule('Grep')).toContain('use Grep to check');
    expect(implementerDeleteOrphanRule('Grep')).toContain('delete it rather than leaving an orphaned module');
  });

  it('lists to-delete in the planner file listing instructions', () => {
    expect(planFileListingInstructions).toContain('"to-delete"');
  });

  it('keeps the reminder sentence case-insensitive and repo-wide', () => {
    expect(needleSearchReminder).toContain('case-insensitively across the whole repository');
  });
});
