import { CliPresenter } from './cli-presenter.service';

describe('CliPresenter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('prints stage headers and separators', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new CliPresenter();

    presenter.stageHeader(2, 'Generate Implementation Plan');
    presenter.separator();

    const output = consoleLogSpy.mock.calls.map(([value]) => String(value)).join('\n');
    expect(output).toContain('🤖 STAGE 2: Generate Implementation Plan');
    expect(output).toContain('─'.repeat(70));
  });

  it('prints progress, outcomes, details, and summary blocks', () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const presenter = new CliPresenter();

    presenter.progress('Checking state');
    presenter.outcome('success', 'Plan generated');
    presenter.detail('Summary', 'Fix login');
    presenter.summaryBlock([{ label: 'Action', value: 'fix' }]);

    const output = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('Checking state');
    expect(output).toContain('Plan generated');
    expect(output).toContain('Summary');
    expect(output).toContain('Action');
  });
});
