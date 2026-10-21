import { aiRequestSchema } from './ai.schema';
import {
  pullStepAssessmentResponseJsonSchema,
  pullStepAssessmentResponseSchema,
  stepAssessmentResponseJsonSchema,
  stepAssessmentResponseSchema,
  stepAssessmentSchema,
  stepStatusSchema,
} from './step-verification.schema';

describe('stepStatusSchema', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts done', () => expect(stepStatusSchema.parse('done')).toBe('done'));
  it('accepts partially-done', () => expect(stepStatusSchema.parse('partially-done')).toBe('partially-done'));
  it('accepts not-done', () => expect(stepStatusSchema.parse('not-done')).toBe('not-done'));
  it('accepts not-applicable', () => expect(stepStatusSchema.parse('not-applicable')).toBe('not-applicable'));
  it('accepts unverifiable', () => expect(stepStatusSchema.parse('unverifiable')).toBe('unverifiable'));
  it('rejects an unknown status', () => expect(() => stepStatusSchema.parse('skipped')).toThrow());
});

describe('stepAssessmentSchema', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts done without missing', () => expect(stepAssessmentSchema.parse({ index: 0, status: 'done' })).toMatchObject({ index: 0, status: 'done' }));
  it('accepts not-applicable without missing', () => expect(stepAssessmentSchema.parse({ index: 1, status: 'not-applicable' })).toMatchObject({ status: 'not-applicable' }));
  it('accepts partially-done with missing', () => expect(stepAssessmentSchema.parse({ index: 0, status: 'partially-done', missing: 'detail' })).toMatchObject({ status: 'partially-done', missing: 'detail' }));
  it('accepts not-done with missing', () => expect(stepAssessmentSchema.parse({ index: 0, status: 'not-done', missing: 'detail' })).toMatchObject({ status: 'not-done', missing: 'detail' }));
  it('accepts unverifiable with missing', () => expect(stepAssessmentSchema.parse({ index: 0, status: 'unverifiable', missing: 'temporal ordering is absent from a diff' })).toMatchObject({ status: 'unverifiable' }));
  it('rejects partially-done without missing', () => expect(() => stepAssessmentSchema.parse({ index: 0, status: 'partially-done' })).toThrow());
  it('rejects not-done without missing', () => expect(() => stepAssessmentSchema.parse({ index: 0, status: 'not-done' })).toThrow());
  it('rejects unverifiable without missing', () => expect(() => stepAssessmentSchema.parse({ index: 0, status: 'unverifiable' })).toThrow());
  it('rejects a negative index', () => expect(() => stepAssessmentSchema.parse({ index: -1, status: 'done' })).toThrow());
  it('rejects a float index', () => expect(() => stepAssessmentSchema.parse({ index: 0.5, status: 'done' })).toThrow());
});

describe('stepAssessmentResponseSchema', () => {
  afterEach(() => jest.restoreAllMocks());
  it('parses an array of assessments', () => {
    const result = stepAssessmentResponseSchema.parse({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'not-applicable' }] });
    expect(result.statuses).toHaveLength(2);
  });
  it('rejects a missing statuses array', () => expect(() => stepAssessmentResponseSchema.parse({})).toThrow());
  it('describes the required response envelope and status values', () => {
    expect(stepAssessmentResponseJsonSchema.required).toEqual(['statuses']);
    expect(stepAssessmentResponseJsonSchema.properties.statuses.items.properties.status.enum).toEqual(['done', 'partially-done', 'not-done', 'not-applicable', 'unverifiable']);
  });
});

describe('pullStepAssessmentResponseSchema', () => {
  afterEach(() => jest.restoreAllMocks());
  it('rejects a payload missing inspectedPaths', () => {
    expect(() => pullStepAssessmentResponseSchema.parse({ statuses: [{ index: 0, status: 'done' }] })).toThrow();
  });
  it('accepts statuses with an empty inspectedPaths', () => {
    const parsed = pullStepAssessmentResponseSchema.parse({ statuses: [{ index: 0, status: 'done' }], inspectedPaths: [] });
    expect(parsed.inspectedPaths).toEqual([]);
  });
  it('requires inspectedPaths at the top level of the JSON schema and reuses the statuses definition', () => {
    expect(pullStepAssessmentResponseJsonSchema.required).toEqual(['statuses', 'inspectedPaths']);
    expect(pullStepAssessmentResponseJsonSchema.additionalProperties).toBe(false);
    const { statuses } = stepAssessmentResponseJsonSchema.properties;
    expect(pullStepAssessmentResponseJsonSchema.properties.statuses).toBe(statuses);
  });
});

describe('AI structured output request', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts a named JSON schema without changing ordinary requests', () => {
    const schema = { type: 'object', properties: { value: { type: 'string' } } };
    expect(aiRequestSchema.parse({ prompt: 'plain' })).toEqual({ prompt: 'plain' });
    expect(aiRequestSchema.parse({ prompt: 'structured', structuredOutput: { name: 'example', schema } }).structuredOutput).toEqual({ name: 'example', schema });
  });
});
