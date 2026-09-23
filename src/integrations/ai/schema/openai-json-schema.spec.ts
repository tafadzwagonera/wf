import { normalizeOpenAiJsonSchema, serializeOpenAiJsonSchema } from './openai-json-schema';

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
});
