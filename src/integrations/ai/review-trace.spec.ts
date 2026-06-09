import {
  formatReviewCallStack,
  formatReviewStateTransition,
} from './review-trace';

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
