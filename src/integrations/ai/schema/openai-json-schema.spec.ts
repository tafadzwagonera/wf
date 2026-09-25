import { denormalizeOpenAiStructuredOutput, normalizeOpenAiJsonSchema, serializeOpenAiJsonSchema } from './openai-json-schema';
import { stepAssessmentResponseJsonSchema, stepAssessmentResponseSchema } from '../../../shared/schemas/step-verification.schema';
import { stepFidelityResponseJsonSchema } from '../../../shared/schemas/step-spec-fidelity.schema';

describe('OpenAI JSON schema normalization', () => {
  it('returns undefined for absent and non-object schemas', () => {
    expect(normalizeOpenAiJsonSchema(undefined)).toBeUndefined();
    expect(normalizeOpenAiJsonSchema('schema')).toBeUndefined();
    expect(serializeOpenAiJsonSchema([])).toBeUndefined();
  });

  it('normalizes nested schema metadata, unions, definitions, arrays, and records', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            propertyNames: { type: 'string' },
            properties: { value: { type: 'string' } },
          },
        },
        union: { anyOf: [{ $schema: 'nested', type: 'string' }, { type: 'number' }] },
      },
      $defs: {
        item: { oneOf: [{ type: 'string' }, { propertyNames: { type: 'string' } }] },
      },
    };

    const normalized = normalizeOpenAiJsonSchema(schema);
    expect(normalized).toEqual({
      type: 'object',
      properties: {
        entries: {
          anyOf: [{
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
              required: ['value'],
            },
          }, { type: 'null' }],
        },
        union: {
          anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }],
        },
      },
      required: ['entries', 'union'],
      $defs: {
        item: { oneOf: [{ type: 'string' }, { additionalProperties: false }] },
      },
    });
  });

  it('makes optional properties required and nullable without double wrapping null', () => {
    const normalized = normalizeOpenAiJsonSchema({
      type: 'object',
      properties: {
        optional: { type: 'string' },
        nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        typedNullable: { type: ['string', 'null'] },
      },
      required: ['nullable'],
    });

    expect(normalized?.required).toEqual(['optional', 'nullable', 'typedNullable']);
    expect(normalized?.properties).toEqual({
      optional: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      typedNullable: { type: ['string', 'null'] },
    });
  });

  it('does not mutate caller-owned schemas', () => {
    const schema = {
      $schema: 'schema',
      properties: { value: { type: 'string' } },
      required: [],
    };
    const original = structuredClone(schema);

    normalizeOpenAiJsonSchema(schema);

    expect(schema).toEqual(original);
  });

  it('serializes the normalized schema', () => {
    expect(serializeOpenAiJsonSchema({ $schema: 'schema', type: 'object' })).toBe('{"type":"object"}');
  });

  it('recurses into allOf members and not child', () => {
    const normalized = normalizeOpenAiJsonSchema({
      allOf: [
        { $schema: 'draft', type: 'object', properties: { x: { type: 'string' } } },
      ],
      not: { $schema: 'draft', type: 'object' },
    });
    expect((normalized?.allOf as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'object',
      properties: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['x'],
    });
    expect(normalized?.not).toEqual({ type: 'object' });
  });

  it('recurses into additionalProperties when it is a schema object', () => {
    const normalized = normalizeOpenAiJsonSchema({
      type: 'object',
      additionalProperties: { $schema: 'draft', type: 'string' },
    });
    expect(normalized?.additionalProperties).toEqual({ type: 'string' });
  });

  it('returns undefined for a numeric primitive root', () => {
    expect(normalizeOpenAiJsonSchema(42)).toBeUndefined();
  });

  it('preserves stepFidelityResponseJsonSchema structure after normalization', () => {
    const normalized = normalizeOpenAiJsonSchema(stepFidelityResponseJsonSchema);
    expect(normalized?.type).toBe('object');
    expect(normalized?.required as string[]).toContain('findings');
    const findingsProp = (normalized?.properties as Record<string, unknown>)
      ?.findings as Record<string, unknown>;
    expect(findingsProp).toBeDefined();
    const items = findingsProp?.items as Record<string, unknown>;
    expect(items?.type).toBe('object');
    expect(items?.additionalProperties).toBe(false);
    expect(items?.required as string[]).toEqual(
      expect.arrayContaining(['severity', 'claim', 'deviation']),
    );
    expect(serializeOpenAiJsonSchema(stepFidelityResponseJsonSchema)).toBeDefined();
  });
});

describe('OpenAI structured output denormalization', () => {
  it('strips null from an optional non-nullable property and reports its path', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } } };
    expect(denormalizeOpenAiStructuredOutput({ a: 'x', b: null }, schema))
      .toEqual({ value: { a: 'x' }, strippedPaths: ['b'] });
  });

  it('preserves null on properties listed in the original required array', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    expect(denormalizeOpenAiStructuredOutput({ a: null }, schema))
      .toEqual({ value: { a: null }, strippedPaths: [] });
  });

  it('preserves null when the original property schema already allows null', () => {
    const schema = {
      type: 'object',
      properties: {
        union: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        typed: { type: ['string', 'null'] },
      },
    };
    expect(denormalizeOpenAiStructuredOutput({ union: null, typed: null }, schema))
      .toEqual({ value: { union: null, typed: null }, strippedPaths: [] });
  });

  it('recurses through array items and nested objects with indexed paths', () => {
    const schema = {
      type: 'object',
      required: ['rows'],
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, note: { type: 'string' } } },
        },
      },
    };
    expect(denormalizeOpenAiStructuredOutput({ rows: [{ id: 1, note: null }, { id: 2, note: 'kept' }] }, schema))
      .toEqual({ value: { rows: [{ id: 1 }, { id: 2, note: 'kept' }] }, strippedPaths: ['rows[0].note'] });
  });

  it('leaves keys not declared in the original properties untouched', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(denormalizeOpenAiStructuredOutput({ extra: null }, schema))
      .toEqual({ value: { extra: null }, strippedPaths: [] });
  });

  it('does not descend into anyOf or oneOf branches', () => {
    const schema = {
      type: 'object',
      required: ['choice'],
      properties: { choice: { anyOf: [{ type: 'object', properties: { opt: { type: 'string' } } }, { type: 'string' }] } },
    };
    expect(denormalizeOpenAiStructuredOutput({ choice: { opt: null } }, schema))
      .toEqual({ value: { choice: { opt: null } }, strippedPaths: [] });
  });

  it('leaves allOf-composed and additionalProperties dictionary schemas untouched', () => {
    const composed = { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] };
    const dictionary = { type: 'object', additionalProperties: { type: 'string' } };
    expect(denormalizeOpenAiStructuredOutput({ a: null }, composed))
      .toEqual({ value: { a: null }, strippedPaths: [] });
    expect(denormalizeOpenAiStructuredOutput({ key: null }, dictionary))
      .toEqual({ value: { key: null }, strippedPaths: [] });
  });

  it('does not mutate the caller-owned value', () => {
    const value = { a: 'x', b: null };
    const original = structuredClone(value);
    denormalizeOpenAiStructuredOutput(value, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } });
    expect(value).toEqual(original);
  });

  it('returns the value unchanged for non-object schemas and non-object values', () => {
    expect(denormalizeOpenAiStructuredOutput({ a: null }, undefined))
      .toEqual({ value: { a: null }, strippedPaths: [] });
    expect(denormalizeOpenAiStructuredOutput('raw', { type: 'object' }))
      .toEqual({ value: 'raw', strippedPaths: [] });
  });

  it('round-trips stepAssessmentResponseJsonSchema so a normalized-schema OpenAI response passes the caller Zod schema', () => {
    expect(normalizeOpenAiJsonSchema(stepAssessmentResponseJsonSchema)).toBeDefined();
    const openAiPayload = {
      statuses: [
        { index: 0, status: 'done', missing: null },
        { index: 1, status: 'partially-done', missing: 'tests absent' },
      ],
    };
    const { value, strippedPaths } = denormalizeOpenAiStructuredOutput(openAiPayload, stepAssessmentResponseJsonSchema);
    expect(strippedPaths).toEqual(['statuses[0].missing']);
    const parsed = stepAssessmentResponseSchema.parse(value);
    expect(parsed.statuses[0].missing).toBeUndefined();
    expect(parsed.statuses[1].missing).toBe('tests absent');
  });

  it.each(['partially-done', 'not-done'])(
    'surfaces the superRefine failure when %s arrives with a null missing field',
    status => {
      const { value } = denormalizeOpenAiStructuredOutput(
        { statuses: [{ index: 0, status, missing: null }] },
        stepAssessmentResponseJsonSchema,
      );
      const result = stepAssessmentResponseSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(`'missing' is required when status is '${status}'`);
    },
  );
});
