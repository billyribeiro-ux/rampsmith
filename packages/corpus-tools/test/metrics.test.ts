// The runner contract's scoring (corpus/CONTRACT.md): mapping accuracy, fix rate and render
// regressions. Written before src/contract/metrics.ts.
import { describe, expect, it } from 'vitest';
import {
  MAPPING_THRESHOLD,
  buildReport,
  findRegressions,
  scoreFixes,
  scoreMapping,
  spansEqual,
  type FixRecord,
  type MappingRecord,
  type PageScan,
  type ScoredFinding,
} from '../src/contract/metrics.ts';
import type { Span } from '../src/golden.ts';

const header = {
  kind: 'element',
  file: 'sections/header.liquid',
  start: 120,
  tag: 'a',
  anchor: '<a href="/cart">',
} as const;
const footer = {
  kind: 'element',
  file: 'sections/footer.liquid',
  start: 40,
  tag: 'a',
  anchor: '<a href="/account">',
} as const;
const scheme = {
  kind: 'json-value',
  file: 'config/settings_data.json',
  pointer: '/current/color_text',
  start: 50,
  end: 59,
} as const;

function finding(
  id: string,
  span: Span,
  overrides: Partial<Omit<ScoredFinding, 'id' | 'span'>> = {},
): ScoredFinding {
  return {
    id,
    ruleId: 'link-name',
    mapping: 'deterministic',
    span,
    expectedFix: {
      channel: 'theme-patch',
      recipe: 'empty-link',
      outcome: 'fixed',
      targeted: true,
    },
    ...overrides,
  };
}

describe('spansEqual', () => {
  it('compares element spans by file and start tag offset', () => {
    expect(spansEqual(header, { ...header })).toBe(true);
    expect(spansEqual(header, { ...header, start: 121 })).toBe(false);
    expect(spansEqual(header, { ...header, file: 'sections/footer.liquid' })).toBe(false);
    expect(spansEqual(header, { ...header, tag: 'button' })).toBe(false);
  });

  it('compares JSON values by file and pointer, and requires the same offsets', () => {
    expect(spansEqual(scheme, { ...scheme })).toBe(true);
    expect(spansEqual(scheme, { ...scheme, pointer: '/current/color_background' })).toBe(false);
    expect(spansEqual(scheme, { ...scheme, end: 60 })).toBe(false);
  });

  it('never equates spans of different kinds', () => {
    expect(spansEqual(header, scheme)).toBe(false);
  });

  it('compares data spans by resource, field and offsets when the golden has offsets', () => {
    const data = {
      kind: 'data',
      resource: 'gid://shopify/Product/1',
      field: 'descriptionHtml',
      start: 3,
      end: 20,
      anchor: '<a href="/x"></a>',
    } as const;
    expect(spansEqual(data, { ...data })).toBe(true);
    expect(spansEqual(data, { ...data, start: 4 })).toBe(false);
    const whole = { kind: 'data', resource: 'gid://shopify/MediaImage/9', field: 'alt' } as const;
    expect(spansEqual(whole, { ...whole })).toBe(true);
    expect(spansEqual(whole, { ...whole, field: 'title' })).toBe(false);
  });
});

describe('scoreMapping', () => {
  const goldens = [
    finding('t/a', header),
    finding('t/b', footer),
    finding('t/c', scheme, { ruleId: 'color-contrast' }),
    finding(
      't/data-only',
      { kind: 'data', resource: 'gid://shopify/MediaImage/1', field: 'alt' },
      {
        ruleId: 'rs-media-alt-empty',
        mapping: 'none',
      },
    ),
  ];

  it('counts a finding correct only when the span matches at or above the threshold', () => {
    const records: MappingRecord[] = [
      { finding: 't/a', status: 'mapped', span: header, confidence: 0.95 },
      { finding: 't/b', status: 'mapped', span: footer, confidence: MAPPING_THRESHOLD },
      { finding: 't/c', status: 'mapped', span: scheme, confidence: 0.89 },
    ];
    const score = scoreMapping(goldens, records);
    expect(score.denominator).toBe(3);
    expect(score.correct).toBe(2);
    expect(score.belowThreshold).toBe(1);
    expect(score.wrongAboveThreshold).toBe(0);
    expect(score.accuracy).toBeCloseTo(2 / 3, 10);
    expect(score.passed).toBe(false);
    expect(score.verdicts).toEqual([
      { finding: 't/a', verdict: 'correct' },
      { finding: 't/b', verdict: 'correct' },
      { finding: 't/c', verdict: 'below-threshold' },
    ]);
  });

  it('leaves data-audit findings, which need no mapping, out of the denominator', () => {
    const records: MappingRecord[] = [
      { finding: 't/a', status: 'mapped', span: header, confidence: 1 },
      { finding: 't/b', status: 'mapped', span: footer, confidence: 1 },
      { finding: 't/c', status: 'mapped', span: scheme, confidence: 1 },
    ];
    const score = scoreMapping(goldens, records);
    expect(score.denominator).toBe(3);
    expect(score.accuracy).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('fails on a single wrong span at or above the threshold, even at high accuracy', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding(`t/x${String(i)}`, { ...header, start: i * 10 }),
    );
    const records: MappingRecord[] = many.map((g, i) => ({
      finding: g.id,
      status: 'mapped',
      span: i === 0 ? footer : g.span,
      confidence: 0.99,
    }));
    const score = scoreMapping(many, records);
    expect(score.accuracy).toBeCloseTo(39 / 40, 10);
    expect(score.wrongAboveThreshold).toBe(1);
    expect(score.passed).toBe(false);
    expect(score.verdicts[0]).toEqual({ finding: 't/x0', verdict: 'wrong-above-threshold' });
  });

  it('accepts a wrong span below the threshold as not mapped, not as wrong', () => {
    const records: MappingRecord[] = [
      { finding: 't/a', status: 'mapped', span: footer, confidence: 0.6 },
    ];
    const score = scoreMapping([finding('t/a', header)], records);
    expect(score.wrongAboveThreshold).toBe(0);
    expect(score.belowThreshold).toBe(1);
    expect(score.correct).toBe(0);
  });

  it('counts needs_review, unmapped and missing records as not mapped', () => {
    const records: MappingRecord[] = [
      { finding: 't/a', status: 'needs_review' },
      { finding: 't/b', status: 'unmapped' },
    ];
    const score = scoreMapping(goldens, records);
    expect(score.needsReview).toBe(1);
    expect(score.unmapped).toBe(1);
    expect(score.missing).toBe(1);
    expect(score.correct).toBe(0);
    expect(score.passed).toBe(false);
  });

  it('passes at exactly 95% with no wrong span', () => {
    const twenty = Array.from({ length: 20 }, (_, i) =>
      finding(`t/y${String(i)}`, { ...header, start: i }),
    );
    const records: MappingRecord[] = twenty.map((g, i) =>
      i === 0
        ? { finding: g.id, status: 'needs_review' }
        : { finding: g.id, status: 'mapped', span: g.span, confidence: 0.9 },
    );
    const score = scoreMapping(twenty, records);
    expect(score.accuracy).toBe(0.95);
    expect(score.passed).toBe(true);
  });

  it('rejects records for unknown findings, duplicates and invalid confidences', () => {
    expect(() => scoreMapping(goldens, [{ finding: 'nope', status: 'unmapped' }])).toThrow(
      /unknown finding nope/,
    );
    expect(() =>
      scoreMapping(goldens, [
        { finding: 't/a', status: 'unmapped' },
        { finding: 't/a', status: 'unmapped' },
      ]),
    ).toThrow(/twice/);
    expect(() =>
      scoreMapping(goldens, [{ finding: 't/a', status: 'mapped', span: header, confidence: 1.2 }]),
    ).toThrow(/confidence/);
    expect(() => scoreMapping(goldens, [{ finding: 't/a', status: 'mapped' }])).toThrow(
      /span and a confidence/,
    );
  });

  it('never passes an empty denominator', () => {
    const score = scoreMapping([], []);
    expect(score.denominator).toBe(0);
    expect(score.accuracy).toBe(0);
    expect(score.passed).toBe(false);
  });
});

describe('scoreFixes', () => {
  const goldens = [
    finding('t/a', header),
    finding('t/b', footer),
    finding('t/c', scheme, {
      ruleId: 'color-contrast',
      expectedFix: { channel: 'theme-patch', recipe: 'contrast', outcome: 'fixed', targeted: true },
    }),
    finding(
      't/refuse',
      { ...header, start: 900 },
      {
        expectedFix: {
          channel: 'theme-patch',
          recipe: 'empty-link',
          outcome: 'refused',
          refusal: 'dynamic-content',
          targeted: false,
        },
      },
    ),
  ];

  it('counts a targeted finding fixed when the engine edited and the rescan no longer fires it', () => {
    const records: FixRecord[] = [
      { finding: 't/a', engine: 'edits', stillFiring: false },
      { finding: 't/b', engine: 'edits', stillFiring: true },
      { finding: 't/c', engine: 'refusal', refusal: 'invalid-parameter', stillFiring: true },
      { finding: 't/refuse', engine: 'refusal', refusal: 'dynamic-content', stillFiring: true },
    ];
    const score = scoreFixes(goldens, records);
    expect(score.targeted).toBe(3);
    expect(score.fixed).toBe(1);
    expect(score.fixRate).toBeCloseTo(1 / 3, 10);
    expect(score.verdicts).toEqual([
      { finding: 't/a', verdict: 'fixed' },
      { finding: 't/b', verdict: 'still-firing' },
      { finding: 't/c', verdict: 'not-patched' },
      { finding: 't/refuse', verdict: 'refused-as-expected' },
    ]);
    expect(score.unexpected).toEqual([]);
  });

  it('reports an engine that edits where the golden expects a refusal, or refuses differently', () => {
    const records: FixRecord[] = [
      { finding: 't/a', engine: 'edits', stillFiring: false },
      { finding: 't/b', engine: 'edits', stillFiring: false },
      { finding: 't/c', engine: 'edits', stillFiring: false },
      { finding: 't/refuse', engine: 'edits', stillFiring: false },
    ];
    const score = scoreFixes(goldens, records);
    expect(score.fixRate).toBe(1);
    expect(score.unexpected).toEqual([
      { finding: 't/refuse', expected: 'refused:dynamic-content', actual: 'edits' },
    ]);
    const other = scoreFixes(goldens, [
      { finding: 't/refuse', engine: 'refusal', refusal: 'wrong-element', stillFiring: true },
    ]);
    expect(other.unexpected).toEqual([
      {
        finding: 't/refuse',
        expected: 'refused:dynamic-content',
        actual: 'refused:wrong-element',
      },
    ]);
  });

  it('treats already-fixed on a targeted finding as not fixed: the golden says it fires', () => {
    const score = scoreFixes(goldens, [
      { finding: 't/a', engine: 'already-fixed', stillFiring: true },
    ]);
    expect(score.verdicts[0]).toEqual({ finding: 't/a', verdict: 'not-patched' });
    expect(score.fixed).toBe(0);
  });

  it('counts a missing record for a targeted finding as not patched', () => {
    const score = scoreFixes(goldens, []);
    expect(score.fixed).toBe(0);
    expect(score.verdicts.filter((v) => v.verdict === 'missing')).toHaveLength(4);
  });

  it('rejects records for unknown findings and duplicates', () => {
    expect(() =>
      scoreFixes(goldens, [{ finding: 'x', engine: 'edits', stillFiring: false }]),
    ).toThrow(/unknown finding x/);
    expect(() =>
      scoreFixes(goldens, [
        { finding: 't/a', engine: 'edits', stillFiring: false },
        { finding: 't/a', engine: 'edits', stillFiring: false },
      ]),
    ).toThrow(/twice/);
  });
});

describe('findRegressions', () => {
  const before: PageScan[] = [
    { theme: 't', page: 'index', rendered: true, counts: { 'link-name:violation': 3 } },
    {
      theme: 't',
      page: 'product',
      rendered: true,
      counts: { 'label:violation': 1, 'color-contrast:incomplete': 2 },
    },
  ];

  it('finds none when every count stays or drops', () => {
    const after: PageScan[] = [
      { theme: 't', page: 'index', rendered: true, counts: { 'link-name:violation': 0 } },
      { theme: 't', page: 'product', rendered: true, counts: { 'color-contrast:incomplete': 2 } },
    ];
    expect(findRegressions(before, after)).toEqual([]);
  });

  it('reports a page that no longer renders, a missing page and a rising count', () => {
    const after: PageScan[] = [
      { theme: 't', page: 'index', rendered: false, error: 'Liquid syntax error', counts: {} },
      {
        theme: 't',
        page: 'product',
        rendered: true,
        counts: { 'label:violation': 1, 'duplicate-id-aria:incomplete': 1 },
      },
    ];
    expect(findRegressions(before, after)).toEqual([
      { theme: 't', page: 'index', kind: 'render-failed', detail: 'Liquid syntax error' },
      {
        theme: 't',
        page: 'product',
        kind: 'new-result',
        detail: 'duplicate-id-aria:incomplete rose from 0 to 1',
      },
    ]);
    expect(findRegressions(before, after.slice(1))).toContainEqual({
      theme: 't',
      page: 'index',
      kind: 'page-missing',
      detail: 'the page was scanned before the patch but not after',
    });
  });

  it('counts new Theme Check offenses as regressions', () => {
    expect(findRegressions(before, before, [{ theme: 't', count: 2 }])).toEqual([
      { theme: 't', page: '*', kind: 'theme-check', detail: '2 new Theme Check offenses' },
    ]);
  });
});

describe('buildReport', () => {
  it('passes only when both gates pass', () => {
    const goldens = [finding('t/a', header)];
    const mapping = scoreMapping(goldens, [
      { finding: 't/a', status: 'mapped', span: header, confidence: 1 },
    ]);
    const fixes = scoreFixes(goldens, [{ finding: 't/a', engine: 'edits', stillFiring: false }]);
    const good = buildReport({ mapping, fixes, regressions: [] });
    expect(good.gates).toEqual({ mapping: true, fixes: true });
    expect(good.passed).toBe(true);
    const bad = buildReport({
      mapping,
      fixes,
      regressions: [{ theme: 't', page: 'index', kind: 'render-failed', detail: 'x' }],
    });
    expect(bad.gates).toEqual({ mapping: true, fixes: false });
    expect(bad.passed).toBe(false);
  });
});
