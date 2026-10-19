import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  classifyCoverage,
  coverageFromRules,
  criteriaFromAxeTags,
  ReportInputError,
} from '../src/index.ts';
import { WCAG22_AA, compareCriteria, isWcag22AaCriterion } from '../src/wcag.ts';

describe('the WCAG 2.2 A and AA list', () => {
  it('has 31 Level A and 24 Level AA criteria, without the removed 4.1.1', () => {
    expect(WCAG22_AA.filter((c) => c.level === 'A')).toHaveLength(31);
    expect(WCAG22_AA.filter((c) => c.level === 'AA')).toHaveLength(24);
    expect(isWcag22AaCriterion('4.1.1')).toBe(false);
  });

  it('is in numeric order with no duplicates', () => {
    const ids = WCAG22_AA.map((c) => c.id);
    expect([...ids].sort(compareCriteria)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the criteria new in 2.2 and excludes their AAA siblings', () => {
    for (const id of ['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8']) {
      expect(isWcag22AaCriterion(id), id).toBe(true);
    }
    for (const id of ['2.4.12', '2.4.13', '3.3.9', '1.4.6', '2.5.5']) {
      expect(isWcag22AaCriterion(id), id).toBe(false);
    }
  });
});

describe('criteriaFromAxeTags', () => {
  it('reads success-criterion tags and ignores level and category tags', () => {
    expect(
      criteriaFromAxeTags(['cat.text-alternatives', 'wcag2a', 'wcag111', 'wcag21aa', 'wcag1410']),
    ).toEqual(['1.1.1', '1.4.10']);
  });

  it('drops AAA criteria and the removed 4.1.1', () => {
    expect(criteriaFromAxeTags(['wcag2aaa', 'wcag146', 'wcag411', 'wcag412'])).toEqual(['4.1.2']);
  });
});

describe('coverageFromRules', () => {
  it('marks criteria with a rule as tested in part, the rest as needing a person', () => {
    const coverage = coverageFromRules({
      rules: [{ criteria: ['1.1.1'] }, { criteria: ['1.4.3', '1.1.1'] }],
      rulesetVersion: 'test',
    });
    expect(coverage.automated).toEqual([]);
    expect(coverage.partial).toEqual(['1.1.1', '1.4.3']);
    const classified = classifyCoverage(coverage);
    expect(classified.manual).toHaveLength(53);
  });

  it('promotes a criterion to "tested by automated checks" only when a rule covers it', () => {
    expect(
      coverageFromRules({
        rules: [{ criteria: ['3.1.1'] }],
        automated: ['3.1.1'],
        rulesetVersion: 'test',
      }).automated,
    ).toEqual(['3.1.1']);
    expect(() =>
      coverageFromRules({ rules: [], automated: ['3.1.1'], rulesetVersion: 'test' }),
    ).toThrow(ReportInputError);
  });

  it('derives a realistic disclosure from axe-core 4.14.0 rule tags', () => {
    const axe = createRequire(import.meta.url)('axe-core') as {
      version: string;
      getRules(): { ruleId: string; tags: string[] }[];
    };
    expect(axe.version).toBe('4.14.0');
    const rules = axe.getRules().map((r) => ({ criteria: criteriaFromAxeTags(r.tags) }));
    const coverage = classifyCoverage(
      coverageFromRules({ rules, rulesetVersion: `axe-core ${axe.version}` }),
    );
    const partial = coverage.partial.map((c) => c.id);
    const manual = coverage.manual.map((c) => c.id);
    // axe-core has rules for these...
    for (const id of ['1.1.1', '1.3.1', '1.4.3', '2.4.2', '3.1.1', '4.1.2']) {
      expect(partial, id).toContain(id);
    }
    // ...and none for these, which need a person.
    for (const id of ['1.2.3', '2.4.5', '3.2.6', '3.3.7', '3.3.8']) {
      expect(manual, id).toContain(id);
    }
    expect(partial).toHaveLength(23);
    expect(manual).toHaveLength(32);
  });
});

describe('classifyCoverage', () => {
  it('lists every A and AA criterion exactly once, in order', () => {
    const c = classifyCoverage({ automated: ['3.1.1'], partial: ['1.1.1'], rulesetVersion: 'v' });
    expect(c.automated.map((x) => x.id)).toEqual(['3.1.1']);
    expect(c.partial.map((x) => x.id)).toEqual(['1.1.1']);
    expect(c.manual).toHaveLength(53);
    expect(c.manual[0]?.id).toBe('1.2.1');
  });

  it.each([
    [{ automated: ['9.9.9'], partial: [], rulesetVersion: 'v' }, /9\.9\.9/u],
    [{ automated: ['1.4.6'], partial: [], rulesetVersion: 'v' }, /1\.4\.6/u],
    [{ automated: ['1.1.1'], partial: ['1.1.1'], rulesetVersion: 'v' }, /both/u],
    [{ automated: [], partial: [], rulesetVersion: '' }, /ruleset/u],
    [{ automated: [], partial: [], rulesetVersion: 'v', reviewQueue: -1 }, /review/u],
    [{ automated: [], partial: [], rulesetVersion: 'v', reviewQueue: 1.5 }, /review/u],
  ])('refuses an invalid disclosure %#', (input, error) => {
    expect(() => classifyCoverage(input)).toThrow(error);
  });
});
