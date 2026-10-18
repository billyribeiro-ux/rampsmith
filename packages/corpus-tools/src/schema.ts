// JSON Schema validation of the golden files and the manifest (draft 2020-12, Ajv 8).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { CORPUS_ROOT } from './paths.ts';

export type SchemaName = 'golden' | 'manifest' | 'runner-records' | 'runner-report';

function compile(name: SchemaName): ValidateFunction {
  const ajv = new Ajv2020({
    strict: true,
    // `required` inside `if`/`then`/`not` names properties defined one level up; that is valid
    // JSON Schema, and the lint would force duplicating every property definition.
    strictRequired: false,
    allErrors: true,
  });
  const schema: unknown = JSON.parse(
    readFileSync(join(CORPUS_ROOT, 'schema', `${name}.schema.json`), 'utf8'),
  );
  if (typeof schema !== 'object' || schema === null)
    throw new Error(`${name} schema is not an object`);
  return ajv.compile(schema);
}

const cache = new Map<SchemaName, ValidateFunction>();

function validator(name: SchemaName): ValidateFunction {
  let fn = cache.get(name);
  if (fn === undefined) {
    fn = compile(name);
    cache.set(name, fn);
  }
  return fn;
}

function describe(error: ErrorObject): string {
  const where = error.instancePath === '' ? '(root)' : error.instancePath;
  return `${where} ${error.message ?? error.keyword}`;
}

/** Validates a parsed JSON value; returns the errors, empty when valid. */
export function validate(name: SchemaName, value: unknown): string[] {
  const fn = validator(name);
  if (fn(value)) return [];
  return (fn.errors ?? []).map(describe);
}
