import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../schemas/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));

describe('committed JSON Schemas', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is a titled draft 2020-12 object schema', (file) => {
    const schema = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(typeof schema['title']).toBe('string');
    expect(schema['type']).toBe('object');
  });
});
