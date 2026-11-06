/**
 * JSON Schema (draft-07 subset) → zod converter.
 * Tool inputSchema uses only: type object/string/number/integer/boolean/array,
 * properties, required, additionalProperties, enum, minimum/maximum, maxLength,
 * minLength, items. Anything else degrades to the base type check.
 */

import { z } from 'zod';
import type { JsonSchemaObject } from '../../types/tool.js';

export interface SchemaCompileResult {
  schema: z.ZodType<Record<string, unknown>>;
  /** Per-field validators, used to produce field-level error details. */
  fields: Record<string, z.ZodType>;
}

function baseType(node: Record<string, unknown>): z.ZodType {
  const type = node.type;
  switch (type) {
    case 'string': {
      let schema: z.ZodString = z.string();
      if (typeof node.maxLength === 'number') schema = schema.max(node.maxLength);
      if (typeof node.minLength === 'number') schema = schema.min(node.minLength);
      if (Array.isArray(node.enum)) {
        const values = node.enum.filter((v): v is string => typeof v === 'string');
        if (values.length > 0) return z.enum(values as [string, ...string[]]);
      }
      return schema;
    }
    case 'number':
    case 'integer': {
      let schema: z.ZodNumber = z.number();
      if (type === 'integer') schema = schema.int();
      if (typeof node.minimum === 'number') schema = schema.min(node.minimum);
      if (typeof node.maximum === 'number') schema = schema.max(node.maximum);
      if (Array.isArray(node.enum)) {
        const literals = node.enum.filter((v): v is number => typeof v === 'number');
        if (literals.length > 0) {
          return z.union([schema, ...literals.map((v) => z.literal(v))]);
        }
      }
      return schema;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = typeof node.items === 'object' && node.items !== null ? baseType(node.items as Record<string, unknown>) : z.unknown();
      let schema = z.array(items as z.ZodType);
      if (typeof node.maxItems === 'number') schema = schema.max(node.maxItems);
      return schema;
    }
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      const shape: Record<string, z.ZodType> = {};
      for (const [key, child] of Object.entries(properties)) shape[key] = baseType(child);
      const strict = node.additionalProperties === false;
      return strict ? z.strictObject(shape) : z.object(shape).loose();
    }
    default:
      return z.unknown();
  }
}

/** Compiles a tool inputSchema into a zod object schema. */
export function compileInputSchema(schema: JsonSchemaObject): SchemaCompileResult {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, node] of Object.entries(properties)) {
    const compiled = baseType(node);
    shape[key] = required.has(key) ? compiled : compiled.optional();
  }
  const objectSchema = schema.additionalProperties === false
    ? z.strictObject(shape)
    : z.object(shape).loose();
  return { schema: objectSchema as unknown as z.ZodType<Record<string, unknown>>, fields: shape };
}

/** Validates arguments; returns field-level issues (path + message) on failure. */
export function validateArgs(
  compiled: SchemaCompileResult,
  args: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const result = compiled.schema.safeParse(args);
  if (result.success) {
    return { ok: true, data: result.data as Record<string, unknown> };
  }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return { ok: false, issues };
}
