export type JsonSchemaObject = Record<string, unknown>;

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const containsNullSchema = (schema: JsonSchemaObject): boolean =>
  schema.type === 'null'
  || (Array.isArray(schema.type) && schema.type.includes('null'))
  || ['anyOf', 'oneOf'].some(key =>
    Array.isArray(schema[key])
    && schema[key].some(item => isJsonSchemaObject(item) && containsNullSchema(item))
  );

const makeSchemaNullable = (schema: unknown): unknown => {
  if (!isJsonSchemaObject(schema) || containsNullSchema(schema)) return schema;
  return { anyOf: [schema, { type: 'null' }] };
};

const normalizeSchemaChildren = (schema: JsonSchemaObject): void => {
  for (const key of ['items', 'additionalProperties', 'not']) {
    if (key in schema) schema[key] = normalizeSchema(schema[key]);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    if (Array.isArray(schema[key])) schema[key] = schema[key].map(normalizeSchema);
  }
  if (isJsonSchemaObject(schema.$defs)) {
    schema.$defs = Object.fromEntries(
      Object.entries(schema.$defs).map(([key, value]) => [key, normalizeSchema(value)])
    );
  }
};

const normalizeSchemaProperties = (schema: JsonSchemaObject): void => {
  if (!isJsonSchemaObject(schema.properties)) return;
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [key, normalizeSchema(value)])
  );
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  schema.properties = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, required.has(key) ? value : makeSchemaNullable(value)])
  );
  schema.required = Object.keys(properties);
};

const normalizeSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!isJsonSchemaObject(schema)) return schema;

  const normalized: JsonSchemaObject = { ...schema };
  delete normalized.$schema;
  delete normalized.propertyNames;
  if ('propertyNames' in schema) normalized.additionalProperties = false;
  normalizeSchemaChildren(normalized);
  normalizeSchemaProperties(normalized);
  return normalized;
};

/** Normalizes a caller-owned schema for strict OpenAI-compatible structured output. */
export const normalizeOpenAiJsonSchema = (schema: unknown): JsonSchemaObject | undefined => {
  if (!isJsonSchemaObject(schema)) return undefined;
  return normalizeSchema(schema) as JsonSchemaObject;
};

/** Serializes a schema after applying OpenAI-compatible strict-output normalization. */
export const serializeOpenAiJsonSchema = (schema: unknown): string | undefined => {
  const normalized = normalizeOpenAiJsonSchema(schema);
  return normalized ? JSON.stringify(normalized) : undefined;
};

/** Preserves the legacy CLI helper name while using the shared normalization implementation. */
export const buildSanitisedJsonSchema = serializeOpenAiJsonSchema;
