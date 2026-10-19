// Drift guard: the TypeScript spellings must equal crates/domain's, which match the database's
// check constraints (PLAN §9). Reads the Rust source; changes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/rules.ts';
import { IMPACTS, PAGE_STATES } from '../src/types.ts';

const domain = join(import.meta.dirname, '..', '..', '..', 'crates', 'domain', 'src');

function quotedAfterArrow(source: string): string[] {
  return [...source.matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

describe('spellings shared with crates/domain', () => {
  it('Impact matches impact.rs', () => {
    const source = readFileSync(join(domain, 'impact.rs'), 'utf8');
    const asStr = /fn as_str[\s\S]*?\{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ?? '';
    expect(quotedAfterArrow(asStr)).toEqual([...IMPACTS]);
  });

  it('PageState matches enums.rs', () => {
    const source = readFileSync(join(domain, 'enums.rs'), 'utf8');
    const block = /pub enum PageState \{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ?? '';
    expect(quotedAfterArrow(block)).toEqual([...PAGE_STATES]);
  });
});

describe('the rule catalog', () => {
  it('keys each rule by its own id, with criteria and a summary', () => {
    for (const [key, meta] of Object.entries(RULES)) {
      expect(meta.id).toBe(key);
      expect(key).toMatch(/^rs-[a-z0-9-]+$/);
      expect(meta.criteria.length).toBeGreaterThan(0);
      expect(IMPACTS).toContain(meta.impact);
      expect(meta.summary).toMatch(/^[A-Z].*\.$/);
    }
  });
});
