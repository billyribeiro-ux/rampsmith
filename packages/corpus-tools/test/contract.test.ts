// The runner contract end to end on the real corpus, with an oracle in place of the mapper and
// the patch engine: records and report validate against their schemas, a perfect run passes
// both gates, and the six recipes liquid-patch ships today cannot reach the fix-rate gate
// without the contrast recipe (docs/evidence/ws-11-corpus.md, integration notes).
import { describe, expect, it } from 'vitest';
import {
  FIX_RATE_GATE,
  buildReport,
  findRegressions,
  scoreFixes,
  scoreMapping,
  scored,
  type FixRecord,
  type MappingRecord,
  type PageScan,
} from '../src/contract/metrics.ts';
import { loadCorpus } from '../src/corpus.ts';
import { BUILT_RECIPES } from '../src/golden.ts';
import { validate } from '../src/schema.ts';

const corpus = loadCorpus();
const failing = corpus.themes.filter((t) => t.entry.kind === 'failing');
const goldens = failing.flatMap((t) => scored(t.entry.name, t.golden.findings));

function oracleMapping(): MappingRecord[] {
  return goldens
    .filter((g) => g.mapping !== 'none')
    .map((g) => ({ finding: g.id, status: 'mapped', span: g.span, confidence: 1 }));
}

function oracleFixes(canFix: (recipe: string) => boolean): FixRecord[] {
  return goldens.map((g): FixRecord => {
    const fix = g.expectedFix;
    if (fix.outcome === 'refused') {
      return { finding: g.id, engine: 'refusal', refusal: fix.refusal ?? '', stillFiring: true };
    }
    if (fix.targeted && canFix(fix.recipe)) {
      return { finding: g.id, engine: 'edits', stillFiring: false };
    }
    return { finding: g.id, engine: 'refusal', refusal: 'invalid-parameter', stillFiring: true };
  });
}

const scans: PageScan[] = failing.flatMap((t) =>
  t.entry.pages.map((p) => ({ theme: t.entry.name, page: p.id, rendered: true, counts: {} })),
);

describe('runner contract on the corpus', () => {
  it('counts every rendered finding in the mapping denominator and only targeted ones in the fix rate', () => {
    const rendered = goldens.filter((g) => g.mapping !== 'none');
    expect(rendered).toHaveLength(goldens.length);
    expect(goldens.filter((g) => g.expectedFix.targeted).length).toBeGreaterThanOrEqual(30);
  });

  it('accepts schema-valid records and passes both gates for a perfect mapper and engine', () => {
    const mapping = oracleMapping();
    const fixes = oracleFixes(() => true);
    const records = {
      corpus: '0000000',
      mapping,
      fixes,
      scans: { before: scans, after: scans },
      themeCheck: failing.map((t) => ({ theme: t.entry.name, count: 0 })),
    };
    expect(validate('runner-records', records)).toEqual([]);
    const report = buildReport({
      mapping: scoreMapping(goldens, mapping),
      fixes: scoreFixes(goldens, fixes),
      regressions: findRegressions(records.scans.before, records.scans.after, records.themeCheck),
    });
    expect(validate('runner-report', report)).toEqual([]);
    expect(report.mapping.accuracy).toBe(1);
    expect(report.fixes.fixRate).toBe(1);
    expect(report.fixes.unexpected).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('fails the fix gate with only the recipes liquid-patch ships today: contrast is missing', () => {
    const report = buildReport({
      mapping: scoreMapping(goldens, oracleMapping()),
      fixes: scoreFixes(
        goldens,
        oracleFixes((r) => (BUILT_RECIPES as readonly string[]).includes(r)),
      ),
      regressions: [],
    });
    const targeted = goldens.filter((g) => g.expectedFix.targeted);
    const contrast = targeted.filter((g) => g.expectedFix.recipe === 'contrast').length;
    expect(report.fixes.fixRate).toBeCloseTo((targeted.length - contrast) / targeted.length, 10);
    expect(report.fixes.fixRate).toBeLessThan(FIX_RATE_GATE);
    expect(report.gates).toEqual({ mapping: true, fixes: false });
  });

  it('rejects malformed records', () => {
    const bad = [
      { corpus: 'x', mapping: [], fixes: [], scans: { before: [], after: [] }, themeCheck: [] },
      {
        corpus: '0000000',
        mapping: [{ finding: 'aurora/html-lang', status: 'mapped' }],
        fixes: [],
        scans: { before: [], after: [] },
        themeCheck: [],
      },
      {
        corpus: '0000000',
        mapping: [],
        fixes: [{ finding: 'aurora/html-lang', engine: 'refusal', stillFiring: true }],
        scans: { before: [], after: [] },
        themeCheck: [],
      },
    ];
    for (const records of bad) expect(validate('runner-records', records)).not.toEqual([]);
  });
});
