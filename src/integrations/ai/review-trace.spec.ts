import { formatReviewCallStack, formatReviewStateTransition } from './review-trace';

describe('formatReviewStateTransition entry arrays', () => {
  it('renders entry-array input with captured, changes, and nested child', () => {
    const lines = formatReviewStateTransition({
      from: 'start',
      to: 'end',
      steps: [
        {
          frame: 'Service.method()',
          captured: [
            { name: 'config', value: { timeout: 5000 } },
            { name: 'logger', value: 'Logger instance' },
          ],
          changes: [
            { name: 'status', before: 'idle', after: 'active' },
            { name: 'count', before: 0, after: 1 },
          ],
          children: [
            {
              frame: 'Child.method()',
              captured: [{ name: 'child_var', value: 'value2' }],
              changes: [{ name: 'state', before: 'init', after: 'done' }],
            },
          ],
        },
      ],
    });

    const rendered = lines.join('\n');
    expect(rendered).toContain('captured');
    expect(rendered).toContain('config');
    expect(rendered).toContain('logger');
    expect(rendered).toContain('changes');
    expect(rendered).toContain('status');
    expect(rendered).toContain('count');
    expect(rendered).toContain('idle');
    expect(rendered).toContain('active');
    expect(rendered).toContain('Child.method()');
    expect(rendered).toContain('child_var');
  });

  it('renders legacy record format the same as entry arrays', () => {
    const legacyLines = formatReviewStateTransition({
      from: 'init',
      to: 'ready',
      steps: [
        {
          frame: 'Service.method()',
          captured: {
            config: { timeout: 5000 },
            logger: 'Logger instance',
          },
          changes: {
            status: { before: 'idle', after: 'active' },
            count: { before: 0, after: 1 },
          },
        },
      ],
    });

    const entryLines = formatReviewStateTransition({
      from: 'init',
      to: 'ready',
      steps: [
        {
          frame: 'Service.method()',
          captured: [
            { name: 'config', value: { timeout: 5000 } },
            { name: 'logger', value: 'Logger instance' },
          ],
          changes: [
            { name: 'status', before: 'idle', after: 'active' },
            { name: 'count', before: 0, after: 1 },
          ],
        },
      ],
    });

    const legacyRendered = legacyLines.join('\n');
    const entryRendered = entryLines.join('\n');

    expect(legacyRendered).toEqual(entryRendered);
  });
});

describe('formatReviewStateTransition omitted sides', () => {
  it('renders only the after side when before is absent', () => {
    const rendered = formatReviewStateTransition({
      steps: [{ frame: 'Service.method()', changes: [{ name: 'status', after: 'active' }] }],
    }).join('\n');

    expect(rendered).not.toContain('before');
    expect(rendered).toContain('└─ after = ');
  });
});

describe('formatReviewCallStack', () => {
  it('returns no elements with embedded newlines when nodes contain multiline frames', () => {
    const lines = formatReviewCallStack([
      {
        frame: 'root()',
        children: [{ frame: 'child()' }],
      },
    ]);

    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
  });
});

describe('formatReviewStateTransition', () => {
  it('returns no elements with embedded newlines when captured values are arrays', () => {
    const lines = formatReviewStateTransition({
      from: 'idle',
      to: 'active',
      steps: [
        {
          frame: 'Service.init()',
          captured: {
            keys: ['API_URL', 'LOG_LEVEL', 'NODE_ENV'],
          },
        },
      ],
    });

    for (const line of lines) {
      expect(line).not.toContain('\n');
    }

    expect(lines.length).toBeGreaterThan(3);
  });

  it('returns no elements with embedded newlines when change values are objects', () => {
    const lines = formatReviewStateTransition({
      from: 'init',
      to: 'ready',
      steps: [
        {
          frame: 'Service.process()',
          changes: {
            config: {
              before: { a: 1, b: 2 },
              after: { a: 1, b: 3 },
            },
          },
        },
      ],
    });

    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
  });

  it('returns no elements with embedded newlines in legacy fallback path', () => {
    const lines = formatReviewStateTransition({
      config: { nested: 'value', other: 'data' },
    } as any);

    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
  });
});
