import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@siglo/http';

/** Standard Schema validation alone cannot supply a native provider schema. */
export function resolveJsonSchema(
  schema: StandardSchemaV1,
  explicit?: Record<string, unknown>,
  direction: 'input' | 'output' = 'output'
): Record<string, unknown> {
  if (explicit) return explicit;
  const standard = schema['~standard'] as StandardSchemaV1['~standard'] &
    Partial<StandardJSONSchemaV1['~standard']>;
  if (!standard.jsonSchema) {
    throw new TypeError('Native structured outputs require jsonSchema or a Standard JSON Schema converter');
  }
  return standard.jsonSchema[direction]({ target: 'draft-2020-12' });
}
