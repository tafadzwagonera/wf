import { isUiRelevantTicket } from './detect-ui-relevance';

describe('isUiRelevantTicket', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['a .vue file extension', 'Update BlogCard.vue to fix alignment'],
    ['a .tsx file extension', 'Refactor ProductCard.tsx'],
    ['a .jsx file extension', 'Add animation to Spinner.jsx'],
    ['a /components/ path segment', 'Refactor /components/Hero.vue'],
    ['a /pages/ path segment', 'Add /pages/about.tsx'],
    ['a /layouts/ path segment', 'Move header into /layouts/default.vue'],
    ['the word "component"', 'Add a component for the product card'],
    ['the word "style"', 'Fix the button style'],
    ['the word "layout"', 'Update layout for mobile'],
    ['the word "accessibility"', 'Improve accessibility on the search bar'],
    ['the word "aria"', 'Set aria-label on icon buttons'],
    ['the word "breakpoint"', 'Adjust breakpoint for tablet view'],
    ['the word "card"', 'Redesign the tour card'],
    ['the word "colour"', 'Change the button colour'],
    ['the word "color"', 'Fix the heading color'],
  ])('returns true for a ticket containing %s', (_label, content) => {
    expect(isUiRelevantTicket(content)).toBe(true);
  });

  it('returns false for a plain backend ticket', () => {
    expect(isUiRelevantTicket('Fix database connection timeout in the auth service')).toBe(false);
  });

  it('returns false for "classify" (does not false-positive on class-word boundary)', () => {
    expect(isUiRelevantTicket('classify the error type by category')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isUiRelevantTicket('')).toBe(false);
  });
});
