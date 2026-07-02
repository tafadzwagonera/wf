import { buildCodexCliArgs } from './codex-cli-runner';

describe('buildCodexCliArgs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes --json for new sessions', () => {
    const args = buildCodexCliArgs({
      prompt: 'test',
      model: 'gpt-5.4-mini',
      cwd: '/repo',
    });

    expect(args).toContain('exec');
    expect(args).toContain('--json');
  });

  it('includes --json for resumed sessions', () => {
    const args = buildCodexCliArgs({
      prompt: 'test',
      model: 'gpt-5.4-mini',
      cwd: '/repo',
      sessionId: 'sess-123',
    });

    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('resume');
    expect(args).toContain('sess-123');
    expect(args.indexOf('--json')).toBeLessThan(args.indexOf('resume'));
  });

  it('includes model when specified', () => {
    const args = buildCodexCliArgs({
      prompt: 'test',
      model: 'gpt-5.4-mini',
      cwd: '/repo',
    });

    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4-mini');
  });

  it('includes --full-auto when permissionMode is full-auto', () => {
    const args = buildCodexCliArgs({
      prompt: 'test',
      model: 'gpt-5.4-mini',
      cwd: '/repo',
      permissionMode: 'full-auto',
    });

    expect(args).toContain('--full-auto');
  });

  it('omits --full-auto when permissionMode is not set', () => {
    const args = buildCodexCliArgs({
      prompt: 'test',
      model: 'gpt-5.4-mini',
      cwd: '/repo',
    });

    expect(args).not.toContain('--full-auto');
  });
});
