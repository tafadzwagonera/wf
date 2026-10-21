import { createBoundedStderr } from './bounded-stderr';

describe('createBoundedStderr', () => {
  it('returns everything written when it fits inside the cap', () => {
    const stderr = createBoundedStderr(1024);

    stderr.append(Buffer.from('first '));
    stderr.append(Buffer.from('second'));

    expect(stderr.text()).toBe('first second');
    expect(stderr.totalBytes()).toBe(12);
    expect(stderr.isEmpty()).toBe(false);
  });

  it('reports empty before anything is written', () => {
    const stderr = createBoundedStderr(1024);

    expect(stderr.isEmpty()).toBe(true);
    expect(stderr.text()).toBe('');
    expect(stderr.totalBytes()).toBe(0);
  });

  it('keeps only the trailing bytes once the cap is exceeded', () => {
    const stderr = createBoundedStderr(10);

    stderr.append(Buffer.from('0123456789'));
    stderr.append(Buffer.from('abcdefghij'));

    expect(stderr.text()).toContain('abcdefghij');
    expect(stderr.text()).not.toContain('01234');
  });

  it('marks the text as truncated so a partial tail is never read as the whole output', () => {
    const stderr = createBoundedStderr(4);

    stderr.append(Buffer.from('aaaaaaaaaa'));

    expect(stderr.text()).toMatch(/truncated/i);
  });

  it('counts every byte observed, not just the bytes retained', () => {
    const stderr = createBoundedStderr(4);

    stderr.append(Buffer.from('aaaaaaaaaa'));
    stderr.append(Buffer.from('bbbbb'));

    expect(stderr.totalBytes()).toBe(15);
  });

  it('bounds retained memory regardless of how much is written', () => {
    const stderr = createBoundedStderr(64);

    for (let i = 0; i < 5000; i += 1) stderr.append(Buffer.from('x'.repeat(100)));

    expect(stderr.retainedBytes()).toBeLessThanOrEqual(64);
    expect(stderr.totalBytes()).toBe(500_000);
  });
});
