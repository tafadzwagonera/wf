import {
  headlessPipelineInstruction,
  formatUiDesignScreenshotPathsPromptSection,
  formatUiDesignScreenshotsPlanPromptSection,
  buildUiDesignComplianceSystemPromptSection,
  planFileListingInstructions,
  planStepPrinciples,
  planSubAgentGuidance,
  implementerSearchRule,
  implementerDeleteOrphanRule,
  needleSearchReminder,
  buildReviewPrompt,
  reviewInstructions,
  reviewTraceGuidance,
  reviewSubAgentGuidance,
  reviewOutputSchema,
} from './prompt-fragments';

describe('headlessPipelineInstruction', () => {
  it('frames headless operation: decide from guidance, no final questions', () => {
    expect(headlessPipelineInstruction).toContain('You run headless inside an automated CLI pipeline');
    expect(headlessPipelineInstruction).toContain('Resolve ambiguity yourself');
    expect(headlessPipelineInstruction).toContain('never with questions or offers of further work');
  });
});

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

  it('instructs the model to estimate per-issue risk and includes risk in the schema example', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('probability');
    expect(prompt).toContain('risk-adjusted severity');
    const schemaLineStart = prompt.indexOf('{"summary"');
    const schemaLineEnd = prompt.indexOf('\n', schemaLineStart);
    const parsed = JSON.parse(prompt.substring(schemaLineStart, schemaLineEnd));
    expect(parsed.issues.some((issue: { risk?: number }) => typeof issue.risk === 'number')).toBe(true);
  });

  it('instructs the model to omit risk entirely for documentation issues and shows a risk-less example', () => {
    const prompt = buildReviewPrompt({ diff: 'DIFF', guidelines: [] });
    expect(prompt).toContain('never attach a risk score to them');
    expect(prompt).toContain('omit the "risk" field entirely');
    const schemaLineStart = prompt.indexOf('{"summary"');
    const schemaLineEnd = prompt.indexOf('\n', schemaLineStart);
    const parsed = JSON.parse(prompt.substring(schemaLineStart, schemaLineEnd));
    expect(parsed.issues.some((issue: { risk?: number }) => issue.risk === undefined)).toBe(true);
  });

  it('orders code changes, numbered guidelines, instructions, trace guidance, sub-agent guidance and schema', () => {
    const result = buildReviewPrompt({ diff: 'DIFF', guidelines: ['a'] });
    const positions = [
      'Code Changes:', '1. a', reviewInstructions, reviewTraceGuidance, reviewSubAgentGuidance, reviewOutputSchema,
    ].map(section => result.indexOf(section));
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

  it('joins trace guidance to sub-agent guidance, then two newlines before the schema', () => {
    const result = buildReviewPrompt({ diff: 'D', guidelines: [] });
    expect(result).toContain(`${reviewTraceGuidance}\n${reviewSubAgentGuidance}\n\n${reviewOutputSchema}`);
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

describe('reviewSubAgentGuidance', () => {
  it('delegates call stack, state transition, and flow-anomaly tracing to parallel read-only sub-agents', () => {
    expect(reviewSubAgentGuidance).toContain('sub-agent');
    expect(reviewSubAgentGuidance).toContain('parallel');
    expect(reviewSubAgentGuidance).toContain('call stack');
    expect(reviewSubAgentGuidance).toContain('state captures and mutations');
    expect(reviewSubAgentGuidance).toContain('dead or unreachable code');
    expect(reviewSubAgentGuidance).toContain('impossible states');
  });

  it('requires file:line evidence for every sub-agent claim and discards unevidenced ones', () => {
    expect(reviewSubAgentGuidance).toContain('file:line');
    expect(reviewSubAgentGuidance).toContain('discard');
  });

  it('directs substantiated anomalies into issues with file, line, severity, and risk', () => {
    expect(reviewSubAgentGuidance).toContain('issues');
    expect(reviewSubAgentGuidance).toContain('risk');
  });

  it('falls back to inline tracing when no sub-agent tool is available', () => {
    expect(reviewSubAgentGuidance).toContain('Without a sub-agent tool');
  });
});

describe('planSubAgentGuidance', () => {
  it('scopes delegation to multi-repo or multi-area tickets', () => {
    expect(planSubAgentGuidance).toContain('sub-agent');
    expect(planSubAgentGuidance).toContain('multiple repositories or distinct areas');
  });

  it('decomposes discovery verification into independent sub-agent tasks', () => {
    expect(planSubAgentGuidance).toContain('reuse candidate');
    expect(planSubAgentGuidance).toContain('call sites and consumers');
    expect(planSubAgentGuidance).toContain('repository conventions');
  });

  it('requires file:line evidence and discards unevidenced sub-agent claims', () => {
    expect(planSubAgentGuidance).toContain('file:line');
    expect(planSubAgentGuidance).toContain('discard');
  });

  it('restricts the composed plan fields to substantiated findings', () => {
    expect(planSubAgentGuidance).toContain('affectedFiles');
    expect(planSubAgentGuidance).toContain('affectedFilesContext');
  });

  it('falls back to inline verification for single-repo, single-area tickets', () => {
    expect(planSubAgentGuidance).toContain('single-repo, single-area ticket');
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

  it('instructs the planner to attach an intent only to literal-prescribing steps', () => {
    expect(planStepPrinciples).toContain('`intent`');
    expect(planStepPrinciples).toContain('only when the step prescribes a literal');
    expect(planStepPrinciples).toContain('(a call chain, signature, regex, or test name)');
    expect(planStepPrinciples).toContain('checkable from the diff');
    expect(planStepPrinciples).toContain('`description`');
    expect(planStepPrinciples).toContain('Omit `intent` for every other step');
    expect(planStepPrinciples).not.toContain('stepIntents');
  });

  it('instructs the planner to consolidate related state into a single data structure', () => {
    expect(planStepPrinciples).toContain('consolidate');
    expect(planStepPrinciples).toContain('impossible states');
    expect(planStepPrinciples).toContain('concrete justification');
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
    expect(result).toContain('accompany this prompt call');
  });

  it('includes all basenames when multiple paths provided', () => {
    const result = formatUiDesignScreenshotsPlanPromptSection(['/a/header.png', '/b/footer.jpg']);
    expect(result).toContain('header.png');
    expect(result).toContain('footer.jpg');
  });
});

describe('formatUiDesignScreenshotPathsPromptSection', () => {
  it('returns empty string for empty paths array', () => {
    expect(formatUiDesignScreenshotPathsPromptSection([])).toBe('');
  });

  it('lists full paths and instructs the agent to open every screenshot', () => {
    const result = formatUiDesignScreenshotPathsPromptSection(['/designs/a.png', '/designs/b.jpg']);
    expect(result).toContain('Design screenshots (accessible via filesystem):');
    expect(result).toContain('- /designs/a.png');
    expect(result).toContain('- /designs/b.jpg');
    expect(result).toContain('You MUST open and inspect every screenshot');
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
