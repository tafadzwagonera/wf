import { stepAssessmentResponseSchema, stepAssessmentSchema, stepStatusSchema } from './step-verification.schema';

describe('stepStatusSchema', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts done', () => {
    expect(stepStatusSchema.parse('done')).toBe('done');
  });

  it('accepts partially-done', () => {
    expect(stepStatusSchema.parse('partially-done')).toBe('partially-done');
  });

  it('accepts not-done', () => {
    expect(stepStatusSchema.parse('not-done')).toBe('not-done');
  });

  it('accepts not-applicable', () => {
    expect(stepStatusSchema.parse('not-applicable')).toBe('not-applicable');
  });

  it('rejects an unknown status', () => {
    expect(() => stepStatusSchema.parse('skipped')).toThrow();
  });
});

describe('stepAssessmentSchema', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts done without missing', () => {
    expect(stepAssessmentSchema.parse({ index: 0, status: 'done' })).toMatchObject({ index: 0, status: 'done' });
  });

  it('accepts not-applicable without missing', () => {
    expect(stepAssessmentSchema.parse({ index: 1, status: 'not-applicable' })).toMatchObject({ status: 'not-applicable' });
  });

  it('accepts partially-done with missing', () => {
    expect(stepAssessmentSchema.parse({ index: 0, status: 'partially-done', missing: 'detail' })).toMatchObject({ status: 'partially-done', missing: 'detail' });
  });

  it('accepts not-done with missing', () => {
    expect(stepAssessmentSchema.parse({ index: 0, status: 'not-done', missing: 'detail' })).toMatchObject({ status: 'not-done', missing: 'detail' });
  });

  it('rejects partially-done without missing', () => {
    expect(() => stepAssessmentSchema.parse({ index: 0, status: 'partially-done' })).toThrow();
  });

  it('rejects not-done without missing', () => {
    expect(() => stepAssessmentSchema.parse({ index: 0, status: 'not-done' })).toThrow();
  });

  it('rejects a negative index', () => {
    expect(() => stepAssessmentSchema.parse({ index: -1, status: 'done' })).toThrow();
  });

  it('rejects a float index', () => {
    expect(() => stepAssessmentSchema.parse({ index: 0.5, status: 'done' })).toThrow();
  });
});

describe('stepAssessmentResponseSchema', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses an array of assessments', () => {
    const result = stepAssessmentResponseSchema.parse({
      statuses: [
        { index: 0, status: 'done' },
        { index: 1, status: 'not-applicable' },
      ],
    });
    expect(result.statuses).toHaveLength(2);
  });

  it('rejects a missing statuses array', () => {
    expect(() => stepAssessmentResponseSchema.parse({})).toThrow();
  });
});
