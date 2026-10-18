import { describe, expect, it } from 'vitest';
import {
  AXE_VERSION,
  CUSTOM_RULES,
  SCANNER_TAGS,
  axeRules,
  criterionFromTag,
  ruleCatalog,
  sortCriteria,
} from '../src/rules.ts';

describe('criterionFromTag', () => {
  it('reads one-digit principle and guideline, then the criterion', () => {
    expect(criterionFromTag('wcag143')).toBe('1.4.3');
    expect(criterionFromTag('wcag1412')).toBe('1.4.12');
    expect(criterionFromTag('wcag2411')).toBe('2.4.11');
    expect(criterionFromTag('wcag258')).toBe('2.5.8');
  });

  it('ignores level and non-WCAG tags', () => {
    for (const tag of ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice', 'cat.forms', 'wcag140']) {
      expect(criterionFromTag(tag)).toBeNull();
    }
  });
});

describe('sortCriteria', () => {
  it('orders numerically and drops duplicates', () => {
    expect(sortCriteria(['4.1.2', '1.4.12', '1.4.3', '1.4.3', '2.4.4'])).toEqual([
      '1.4.3',
      '1.4.12',
      '2.4.4',
      '4.1.2',
    ]);
  });
});

describe('rule catalog', () => {
  it('pins axe-core 4.14.0, the version the repository locks', () => {
    expect(AXE_VERSION).toBe('4.14.0');
  });

  it('holds the axe-core rules behind the six top failure types with their criteria', () => {
    const catalog = ruleCatalog();
    const expected: Record<string, string[]> = {
      'color-contrast': ['1.4.3'],
      'image-alt': ['1.1.1'],
      label: ['4.1.2'],
      'select-name': ['4.1.2'],
      'link-name': ['2.4.4', '4.1.2'],
      'button-name': ['4.1.2'],
      'html-has-lang': ['3.1.1'],
      'target-size': ['2.5.8'],
      bypass: ['2.4.1'],
    };
    for (const [id, criteria] of Object.entries(expected)) {
      expect(catalog.get(id), id).toMatchObject({ engine: 'axe', criteria });
    }
  });

  it('leaves out experimental and best-practice-only rules', () => {
    const ids = new Set(axeRules().map((r) => r.id));
    expect(ids.has('p-as-heading')).toBe(false);
    expect(ids.has('region')).toBe(false);
    expect(ids.has('heading-order')).toBe(false);
    expect(SCANNER_TAGS).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });

  it('keeps custom rule ids apart from axe-core ids with the rs- prefix', () => {
    for (const rule of CUSTOM_RULES) {
      expect(rule.id.startsWith('rs-')).toBe(true);
      expect(rule.engine === 'rampsmith-data' || rule.engine === 'rampsmith-browser').toBe(true);
    }
    expect(CUSTOM_RULES).toHaveLength(19);
  });
});
