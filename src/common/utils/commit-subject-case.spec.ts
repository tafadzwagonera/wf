import {
  capitalizeCommitMessageDescription,
  splitSubjectPrefix,
  violatesUppercaseDescription,
} from './commit-subject-case';

describe('splitSubjectPrefix', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses a conventional prefix', () => {
    expect(splitSubjectPrefix('feat(auth): add thing')).toEqual({ prefix: 'feat(auth): ', description: 'add thing' });
  });

  it('parses a conventional prefix without scope', () => {
    expect(splitSubjectPrefix('fix: add thing')).toEqual({ prefix: 'fix: ', description: 'add thing' });
  });

  it('parses a ticket prefix', () => {
    expect(splitSubjectPrefix('ABC-1: add thing')).toEqual({ prefix: 'ABC-1: ', description: 'add thing' });
  });

  it('parses combined ticket + conventional prefix', () => {
    expect(splitSubjectPrefix('ABC-1: feat(x): add y')).toEqual({ prefix: 'ABC-1: feat(x): ', description: 'add y' });
  });

  it('returns empty prefix for freeform subject', () => {
    expect(splitSubjectPrefix('Add thing')).toEqual({ prefix: '', description: 'Add thing' });
  });

  it('handles feat! breaking change', () => {
    expect(splitSubjectPrefix('feat!: add thing')).toEqual({ prefix: 'feat!: ', description: 'add thing' });
  });

  it('handles feat(scope)! breaking change', () => {
    expect(splitSubjectPrefix('feat(scope)!: add thing')).toEqual({ prefix: 'feat(scope)!: ', description: 'add thing' });
  });

  it('does not split mid-description on a colon', () => {
    expect(splitSubjectPrefix('ABC-1: Add retry: cap at 3')).toEqual({ prefix: 'ABC-1: ', description: 'Add retry: cap at 3' });
  });
});

describe('capitalizeCommitMessageDescription', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uppercases a lowercase description after a conventional prefix', () => {
    expect(capitalizeCommitMessageDescription('feat(auth): add JWT token validation'))
      .toBe('feat(auth): Add JWT token validation');
  });

  it('uppercases a lowercase description after a ticket prefix', () => {
    expect(capitalizeCommitMessageDescription('ABC-1: add thing'))
      .toBe('ABC-1: Add thing');
  });

  it('uppercases a lowercase freeform description', () => {
    expect(capitalizeCommitMessageDescription('add thing')).toBe('Add thing');
  });

  it('leaves an already-uppercase description unchanged', () => {
    expect(capitalizeCommitMessageDescription('feat: Add thing')).toBe('feat: Add thing');
  });

  it('leaves a description starting with a digit unchanged', () => {
    expect(capitalizeCommitMessageDescription('feat: 3 items')).toBe('feat: 3 items');
  });

  it('leaves a description starting with a backtick unchanged', () => {
    expect(capitalizeCommitMessageDescription('fix: `null` crash')).toBe('fix: `null` crash');
  });

  it('leaves an empty string unchanged', () => {
    expect(capitalizeCommitMessageDescription('')).toBe('');
  });

  it('is idempotent', () => {
    const msg = 'feat: add thing';
    expect(capitalizeCommitMessageDescription(capitalizeCommitMessageDescription(msg)))
      .toBe(capitalizeCommitMessageDescription(msg));
  });

  it('transforms only the first line and leaves body lines untouched', () => {
    const msg = 'feat: add thing\n\nbody with lowercase line\nsecond body line';
    const result = capitalizeCommitMessageDescription(msg);
    expect(result).toBe('feat: Add thing\n\nbody with lowercase line\nsecond body line');
  });
});

describe('violatesUppercaseDescription', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when description starts with a lowercase ASCII letter after conventional prefix', () => {
    expect(violatesUppercaseDescription('feat: add thing')).toBe(true);
  });

  it('returns false when description starts with uppercase after conventional prefix', () => {
    expect(violatesUppercaseDescription('feat: Add thing')).toBe(false);
  });

  it('returns false when description starts with a digit', () => {
    expect(violatesUppercaseDescription('feat: 3 items')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(violatesUppercaseDescription('')).toBe(false);
  });

  it('returns false for a freeform uppercase subject', () => {
    expect(violatesUppercaseDescription('Add thing')).toBe(false);
  });

  it('returns true for a freeform lowercase subject', () => {
    expect(violatesUppercaseDescription('add thing')).toBe(true);
  });

  it('normalized output never violates the rule', () => {
    const subjects = ['feat: add thing', 'ABC-1: add thing', 'fix!: do stuff', 'ABC-1: feat(x): add y'];
    for (const s of subjects) {
      expect(violatesUppercaseDescription(capitalizeCommitMessageDescription(s))).toBe(false);
    }
  });
});
