/**
 * Structured outputs (PLAN §13: "Every response uses structured outputs against a JSON Schema,
 * then is validated with Ajv before use"; ADR-213).
 *
 * Each task has one strict schema. The API's grammar supports only part of JSON Schema
 * (no `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` subtleties, or `minItems`
 * above 1; https://platform.claude.com/docs/en/build-with-claude/structured-outputs), so the
 * request carries a wire copy with those constraints removed, and Ajv enforces every
 * constraint on the response. The documentation itself says output can still miss the schema
 * (refusals, `max_tokens`), so validation is never skipped.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Constraints the structured-outputs grammar rejects with a 400, enforced by Ajv instead. */
const WIRE_UNSUPPORTED = new Set([
  '$schema',
  '$id',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
  'pattern',
  'format',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep copy of `schema` that the API accepts: unsupported keywords dropped. */
export function toWireSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isRecord(node)) {
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (WIRE_UNSUPPORTED.has(key)) {
        continue;
      }
      if (key === 'minItems' && typeof value === 'number' && value > 1) {
        out[key] = 1;
        continue;
      }
      // `properties` maps names to schemas; every other object-valued keyword is a schema.
      out[key] =
        key === 'properties' && isRecord(value)
          ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub)]))
          : walk(value);
    }
    return out;
  };
  const wire = walk(schema);
  if (!isRecord(wire)) {
    throw new TypeError('a schema must be an object');
  }
  return wire;
}

const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: false });

export interface CompiledSchema<T> {
  readonly strict: JsonSchema;
  readonly wire: JsonSchema;
  /** Returns the value typed, or `null` with a content-free reason. */
  check(value: unknown): { ok: true; value: T } | { ok: false; reason: string };
}

/**
 * Describes a validation failure by location and keyword only. Values are never included:
 * they are model output that may echo merchant content (PLAN §8: no store content in logs).
 */
function describe(errors: readonly ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) {
    return 'schema mismatch';
  }
  return `${first.instancePath === '' ? '/' : first.instancePath} failed ${first.keyword}`;
}

export function compileSchema<T>(strict: JsonSchema): CompiledSchema<T> {
  const validate: ValidateFunction<T> = ajv.compile<T>(strict);
  return {
    strict,
    wire: toWireSchema(strict),
    check(value: unknown) {
      return validate(value)
        ? { ok: true, value }
        : { ok: false, reason: describe(validate.errors) };
    },
  };
}

/** A string property; `maxLength` is enforced by Ajv only. */
export function text(maxLength: number, description: string): JsonSchema {
  return { type: 'string', maxLength, description };
}

/** Builds a closed object schema in which every property is required. */
export function object(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
