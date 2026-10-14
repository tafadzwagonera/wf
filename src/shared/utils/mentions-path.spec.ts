import { mentionsPath } from './mentions-path';

describe('mentionsPath', () => {
  afterEach(() => jest.restoreAllMocks());

  it('matches an exact path', () => {
    expect(mentionsPath('Edit src/a.ts now', 'src/a.ts')).toBe(true);
  });

  it('does not match a longer file name that starts with the path', () => {
    expect(mentionsPath('Edit src/a.tsx', 'src/a.ts')).toBe(false);
  });

  it('does not match a path nested under another directory', () => {
    expect(mentionsPath('Edit src/utils/a.ts', 'a.ts')).toBe(false);
    expect(mentionsPath('Edit src/utils/a.ts', 'utils/a.ts')).toBe(false);
    expect(mentionsPath('Edit src/utils/a.ts', 'src/utils/a.ts')).toBe(true);
  });

  it.each([
    ['backticks', 'Edit `src/a.ts`'],
    ['double quotes', 'Edit "src/a.ts"'],
    ['single quotes', "Edit 'src/a.ts'"],
    ['parentheses', 'Edit (src/a.ts)'],
    ['start of text', 'src/a.ts needs work'],
    ['end of text', 'Edit src/a.ts'],
    ['a trailing comma', 'Edit src/a.ts, then src/b.ts'],
    ['a trailing colon', 'Edit src/a.ts: add a guard'],
    ['a sentence-ending period', 'Update src/a.ts.'],
  ])('matches a path surrounded by %s', (_label, text) => {
    expect(mentionsPath(text, 'src/a.ts')).toBe(true);
  });

  it('matches a path written with a leading ./', () => {
    expect(mentionsPath('Edit ./src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('does not match a path behind another repository prefix or a bare slash', () => {
    expect(mentionsPath('Edit other-repo/src/a.ts', 'src/a.ts')).toBe(false);
    expect(mentionsPath('Edit /src/a.ts', 'src/a.ts')).toBe(false);
  });

  it('treats a dot followed by a word character as part of the name', () => {
    expect(mentionsPath('Edit src/a.ts.bak', 'src/a.ts')).toBe(false);
  });

  it('escapes regular expression metacharacters in the path', () => {
    expect(mentionsPath('Edit pages/[id].vue', 'pages/[id].vue')).toBe(true);
    expect(mentionsPath('Edit pages/i.vue', 'pages/[id].vue')).toBe(false);
    expect(mentionsPath('Edit src/a(b).ts', 'src/a(b).ts')).toBe(true);
    expect(mentionsPath('Edit src/a+b.ts', 'src/a+b.ts')).toBe(true);
    expect(mentionsPath('Edit src/aab.ts', 'src/a+b.ts')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(mentionsPath('Edit SRC/A.TS', 'src/a.ts')).toBe(false);
  });
});
