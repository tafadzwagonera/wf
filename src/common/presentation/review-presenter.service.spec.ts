import { ReviewPresenter } from './review-presenter.service';

const mockReview = {
  summary: 'All looks good',
  issues: [],
  suggestions: [],
  approved: true,
  callStack: [],
  stateTransition: {},
};

describe('ReviewPresenter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders full review with summary, severity-colored issues, suggestions, and verdict', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({
      ...mockReview,
      issues: [
        { severity: 'warning', message: 'Unused variable', file: 'src/auth.ts', line: 42 },
      ],
      suggestions: ['Remove dead code'],
    });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('All looks good');
    expect(output).toContain('warning');
    expect(output).toContain('Unused variable');
    expect(output).toContain('src/auth.ts');
    expect(output).toContain('Remove dead code');
    expect(output).toContain('Approved');
  });

  it('renders the risk and risk-adjusted severity on issues that carry a risk', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({
      ...mockReview,
      issues: [
        { severity: 'error', risk: 0.5, message: 'Unlikely regression', file: 'src/auth.ts', line: 42 },
      ],
    });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('[error → warning (risk 0.5)] Unlikely regression');
  });

  it('renders green checkmark for approved reviews', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({ ...mockReview, approved: true });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('✔');
    expect(output).toContain('Approved');
  });

  it('renders red cross and warning for rejected reviews', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({ ...mockReview, approved: false });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('✗');
    expect(output).toContain('Changes requested');
    expect(output).toContain('⚠ Address the issues above');
  });

  it('renders "No issues found" when issues array is empty', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({ ...mockReview, issues: [] });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('No issues found');
  });

  it('renders "No suggestions" when suggestions array is empty', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({ ...mockReview, suggestions: [] });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('No suggestions');
  });

  it('renders colorized call stack tree when call stack has nodes', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({
      ...mockReview,
      callStack: [{ frame: 'handleAuth (src/auth.ts:10)', children: [] }],
    });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('Call Stack');
    expect(output).toContain('handleAuth');
  });

  it('renders muted fallback when call stack is empty', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({ ...mockReview, callStack: [] });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('(no structured call stack was returned)');
  });

  it('returns plain-text notes without ANSI codes when colorized is false', () => {
    const presenter = new ReviewPresenter();
    // eslint-disable-next-line no-control-regex
    const ansiPattern = /\x1B\[[0-9;]*m/;

    const notes = presenter.formatTraceSectionNotes(
      { ...mockReview, executionMode: 'standard' },
      false,
      'call stack'
    );

    for (const note of notes) {
      expect(note).not.toMatch(ansiPattern);
    }
    expect(notes.join('\n')).toContain('Provenance:');
  });

  it('does not leak array indices into the colorized provenance output', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({
      ...mockReview,
      callStack: [{ frame: 'handleAuth (src/auth.ts:10)', children: [] }],
      executionMode: 'cli',
      traceProvenance: 'evidence-based',
    });

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).not.toMatch(/Execution mode: \w+ \d/);
    expect(output).toContain('Execution mode: cli');
    expect(output).toContain('Provenance: evidence-based');
  });

  it('labels repaired reviews in the provenance output', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new ReviewPresenter();

    presenter.displayReview({
      ...mockReview,
      executionMode: 'standard',
      repairStrategy: 'validation',
      traceProvenance: 'best-effort',
    } as any);

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('Repair strategy: validation');
  });
});
