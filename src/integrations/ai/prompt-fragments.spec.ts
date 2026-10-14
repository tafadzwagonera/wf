import {
  formatUiDesignScreenshotsPlanPromptSection,
  buildUiDesignComplianceSystemPromptSection,
  planFileListingInstructions,
  planStepPrinciples,
  implementerSearchRule,
  implementerDeleteOrphanRule,
  needleSearchReminder,
  buildReviewPrompt,
  reviewInstructions,
  reviewTraceGuidance,
  reviewOutputSchema,
} from './prompt-fragments';

describe('buildReviewPrompt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes frame-aligned tree guidance in trace principles', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('frame-aligned');
  });

  it('includes mirrored-nesting phrase in trace principles', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('mirror the callStack nesting');
  });

  it('references captured and changes fields by name in trace guidance', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('`captured`');
    expect(prompt).toContain('`changes`');
  });

  it('example stateTransition has entry-array captured and changes', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('"captured":[');
    expect(prompt).toContain('"changes":[');
    expect(prompt).toContain('{"name"');
  });

  it('example stateTransition steps are non-empty with entry arrays', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('"steps":[');
    expect(prompt).toContain('"frame":"Service.method(params)"');
    expect(prompt).toContain('"frame":"Helper.transform(input)"');
    expect(prompt).toContain('"approved":true');
  });

  it('reviewOutputSchema example JSON line is valid and has nested stateTransition with entry arrays', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    const schemaLineStart = prompt.indexOf('{"summary"');
    const schemaLineEnd = prompt.indexOf('\n', schemaLineStart);
    const jsonLine = prompt.substring(schemaLineStart, schemaLineEnd);
    const parsed = JSON.parse(jsonLine);
    expect(parsed.stateTransition).toBeDefined();
    expect(parsed.stateTransition.steps).toBeDefined();
    expect(Array.isArray(parsed.stateTransition.steps)).toBe(true);
    expect(parsed.stateTransition.steps.length).toBeGreaterThan(0);
    const step = parsed.stateTransition.steps[0];
    expect(Array.isArray(step.captured)).toBe(true);
    expect(Array.isArray(step.changes)).toBe(true);
    expect(step.children).toBeDefined();
    expect(Array.isArray(step.children)).toBe(true);
    expect(step.children.length).toBeGreaterThan(0);
  });

  it('orders code changes, numbered guidelines, instructions, trace guidance and schema', () => {
    const result = buildReviewPrompt({ diff: 'DIFF', guidelines: ['a'] });
    const positions = ['Code Changes:', '1. a', reviewInstructions, reviewTraceGuidance, reviewOutputSchema]
      .map(section => result.indexOf(section));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('numbers guidelines from 1', () => {
    expect(buildReviewPrompt({ diff: 'D', guidelines: ['a', 'b'] })).toContain('1. a\n2. b');
  });

  it('places the figma section between instructions and trace guidance when supplied', () => {
    const result = buildReviewPrompt({ diff: 'D', guidelines: [], figmaContextSection: 'FIGMA' });
    expect(result.indexOf('FIGMA')).toBeGreaterThan(result.indexOf(reviewInstructions));
    expect(result.indexOf('FIGMA')).toBeLessThan(result.indexOf(reviewTraceGuidance));
  });

  it('omits the figma section and joins instructions to trace guidance directly when not supplied', () => {
    const result = buildReviewPrompt({ diff: 'D', guidelines: [] });
    expect(result).not.toContain('FIGMA');
    expect(result).toContain(`${reviewInstructions}\n${reviewTraceGuidance}`);
  });

  it('puts exactly two newlines between trace guidance and the schema', () => {
    const result = buildReviewPrompt({ diff: 'D', guidelines: [] });
    expect(result).toContain(`${reviewTraceGuidance}\n\n${reviewOutputSchema}`);
  });

  it('renders an empty guidelines block without numbered lines', () => {
    const result = buildReviewPrompt({ diff: 'D', guidelines: [] });
    expect(result).toContain(`Review Guidelines:\n\n\n${reviewInstructions}`);
    expect(result).not.toContain('Review Guidelines:\n1. ');
  });

  it('wraps the diff in a triple-backtick fence', () => {
    expect(buildReviewPrompt({ diff: 'DIFF', guidelines: [] })).toContain('```\nDIFF\n```');
  });
});

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

  it('instructs the planner to emit index-aligned stepIntents only for literal-prescribing steps', () => {
    expect(planStepPrinciples).toContain('`stepIntents`');
    expect(planStepPrinciples).toContain('only for steps that prescribe a literal');
    expect(planStepPrinciples).toContain('(a call chain, signature, regex, or test name)');
    expect(planStepPrinciples).toContain('checkable from the diff');
    expect(planStepPrinciples).toContain('index-aligned with `steps`');
    expect(planStepPrinciples).toContain('`null` for every other step');
  });

  it('requires a call assertion for mocked collaborators', () => {
    expect(planStepPrinciples).toContain(
      '   - Each test step states its observable assertion; when a collaborator is mocked, also assert after the act\n'
      + '     step that it was called and with what arguments (extends the strongest-viable-positive-check rule above).'
    );
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
