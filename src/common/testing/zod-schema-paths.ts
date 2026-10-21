import { z } from 'zod';

const unwrapSchema = (schema: z.ZodType): z.ZodType => {
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodReadonly
  ) {
    return unwrapSchema(schema.unwrap() as z.ZodType);
  }
  return schema;
};

const joinPath = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

const collectObjectPaths = (schema: z.ZodObject, prefix: string): string[] =>
  Object.entries(schema.shape).flatMap(([key, child]) =>
    collectSchemaLeafPaths(child as z.ZodType, joinPath(prefix, key)));

/**
 * List the dotted leaf paths of a Zod object schema. Array elements that are objects
 * contribute `path[].field` entries; records, scalars and enums are leaves.
 *
 * @param schema - Schema to walk
 * @param prefix - Dotted path prefix for nested calls
 * @returns Leaf paths in schema declaration order
 */
export const collectSchemaLeafPaths = (schema: z.ZodType, prefix = ''): string[] => {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodObject) return collectObjectPaths(unwrapped, prefix);
  if (unwrapped instanceof z.ZodArray) {
    const element = unwrapSchema(unwrapped.element as z.ZodType);
    return element instanceof z.ZodObject ? collectObjectPaths(element, `${prefix}[]`) : [prefix];
  }
  return [prefix];
};
