import { describe, expect, it } from 'vitest';
import {
  ALT_TEXT_SCHEMA,
  EXPLAIN_SCHEMA,
  GRADE_SCHEMA,
  PATCH_PROPOSAL_SCHEMA,
  REWRITE_SCHEMA,
  TIE_BREAK_SCHEMA,
} from '../src/outputs.ts';
import { toWireSchema, type JsonSchema } from '../src/schema.ts';

const ALL = {
  ALT_TEXT_SCHEMA,
  REWRITE_SCHEMA,
  TIE_BREAK_SCHEMA,
  PATCH_PROPOSAL_SCHEMA,
  EXPLAIN_SCHEMA,
  GRADE_SCHEMA,
};

/** Keywords the structured-outputs documentation lists as supported (read 2026-10-17). */
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'allOf',
  '$ref',
  '$defs',
  'definitions',
  'default',
  'description',
  'minItems',
]);

function walk(node: unknown, visit: (schema: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => {
      walk(n, visit);
    });
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  visit(record);
  for (const [k, v] of Object.entries(record)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      Object.values(v).forEach((s) => {
        walk(s, visit);
      });
    } else if (k === 'items' || k === 'anyOf' || k === 'allOf') {
      walk(v, visit);
    }
  }
}

describe('wire schemas sent as output_config.format', () => {
  it.each(Object.entries(ALL))('%s uses only supported keywords', (_name, schema) => {
    walk(schema.wire, (node) => {
      for (const key of Object.keys(node)) {
        expect(SUPPORTED.has(key), `unsupported keyword ${key}`).toBe(true);
      }
      if (node['minItems'] !== undefined) {
        expect([0, 1]).toContain(node['minItems']);
      }
    });
  });

  it.each(Object.entries(ALL))(
    '%s closes every object and requires every property',
    (_n, schema) => {
      walk(schema.wire, (node) => {
        if (node['type'] === 'object') {
          expect(node['additionalProperties']).toBe(false);
          expect([...(node['required'] as string[])].sort()).toEqual(
            Object.keys(node['properties'] as object).sort(),
          );
        }
      });
    },
  );

  it('drops constraints without touching the strict copy', () => {
    const strict: JsonSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { maxLength: { type: 'string', maxLength: 3, pattern: '^a' } },
      required: ['maxLength'],
      additionalProperties: false,
      minItems: 5,
    };
    expect(toWireSchema(strict)).toEqual({
      type: 'object',
      properties: { maxLength: { type: 'string' } },
      required: ['maxLength'],
      additionalProperties: false,
      minItems: 1,
    });
    expect((strict['properties'] as Record<string, Record<string, unknown>>)['maxLength']).toEqual({
      type: 'string',
      maxLength: 3,
      pattern: '^a',
    });
  });
});

describe('strict validation with Ajv', () => {
  const good = {
    alt: 'White ceramic mug with a wooden handle, side view',
    decorative: false,
    contains_text: false,
    instruction_like_text: false,
    language: 'en',
    confidence: 0.92,
  };

  it('accepts a valid alt-text output', () => {
    expect(ALT_TEXT_SCHEMA.check(good)).toEqual({ ok: true, value: good });
  });

  it.each([
    ['a missing property', { ...good, confidence: undefined }],
    ['an extra property', { ...good, html: '<b>x</b>' }],
    ['a wrong type', { ...good, decorative: 'no' }],
    ['an out-of-range number', { ...good, confidence: 1.5 }],
    ['an over-long string', { ...good, alt: 'x'.repeat(301) }],
    ['a malformed language tag', { ...good, language: 'English' }],
    ['an array', [good]],
    ['null', null],
  ])('rejects %s without echoing the value', (_label, value) => {
    const result = ALT_TEXT_SCHEMA.check(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toMatch(/mug|<b>|English/u);
      expect(result.reason).toMatch(/failed [a-zA-Z]+$/u);
    }
  });

  it('accepts null as a tie-break choice', () => {
    expect(
      TIE_BREAK_SCHEMA.check({
        candidate_id: null,
        distinguishing_attribute: { name: '', value: '' },
        confidence: 0.2,
        instruction_like_text: false,
      }).ok,
    ).toBe(true);
  });
});
