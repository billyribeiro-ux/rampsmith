// The R2 gates on the real corpus (PLAN §5, §23; corpus/CONTRACT.md, "The integrated runner";
// ADR-247). Each theme is scanned in Chromium, every finding is mapped to its source by
// liquid-patch's mapper, the engine patches the theme with the mapped spans, and the patched
// theme is rendered and scanned again. These tests fail below the bar:
// - mapping: at least 95% of findings mapped correctly at confidence 0.9 or more, none wrong;
// - fixes: at least 90% of targeted findings fixed, no render regression, no new Theme Check
//   offense in a patched theme.
// They also write the JSON report to test-results/corpus-report.json (git-ignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../src/browser/check.ts';
import {
  FIX_RATE_GATE,
  MAPPING_ACCURACY_GATE,
  MAPPING_THRESHOLD,
} from '../src/contract/metrics.ts';
import { loadCorpus } from '../src/corpus.ts';
import { TOP_SIX_CATEGORIES } from '../src/golden.ts';
import { categoryRows, jsonReport, runnerRecords } from '../src/runner/report.ts';
import { runCorpus, type CorpusRun } from '../src/runner/run.ts';
import { validate } from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus();
let browser: Browser;
let run: CorpusRun;
let withoutContrast: CorpusRun;

beforeAll(async () => {
  browser = await launchChromium();
  run = await runCorpus(browser, corpus);
  const out = join(here, '..', 'test-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'corpus-report.json'), `${JSON.stringify(jsonReport(run), null, 2)}\n`);
  // The gate must be able to fail: the same run without the contrast recipe (the engine of
  // WS-11's measurement) and with the golden spans must land below the fix-rate bar.
  withoutContrast = await runCorpus(browser, corpus, {
    spans: 'golden',
    withoutRecipes: ['color-contrast'],
  });
}, 900_000);

afterAll(async () => {
  await browser.close();
});

function lines(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : `\n  ${items.join('\n  ')}`;
}

describe('the scan joins the golden findings', () => {
  it('has no scanner finding without a golden finding and no golden finding that did not fire', () => {
    expect(run.problems, lines(run.problems)).toEqual([]);
  });
});

describe('mapping gate', () => {
  it('maps every rendered finding to the golden span at confidence 0.9 or more, none wrongly', () => {
    const { mapping } = run.report;
    const missed = mapping.verdicts
      .filter((v) => v.verdict !== 'correct')
      .map((v) => `${v.finding}: ${v.verdict}`);
    expect(mapping.denominator).toBeGreaterThanOrEqual(40);
    expect(mapping.threshold).toBe(MAPPING_THRESHOLD);
    expect(mapping.wrongAboveThreshold, lines(missed)).toBe(0);
    expect(mapping.accuracy, lines(missed)).toBeGreaterThanOrEqual(MAPPING_ACCURACY_GATE);
    expect(run.report.gates.mapping).toBe(true);
  });

  it('records a mapping for every finding that needs one, and a confidence with every span', () => {
    const records = new Map(run.mapping.map((m) => [m.finding, m]));
    for (const golden of run.goldens.filter((g) => g.mapping !== 'none')) {
      const record = records.get(golden.id);
      expect(record, golden.id).toBeDefined();
      if (record?.status === 'mapped') {
        expect(record.confidence, golden.id).toBeGreaterThanOrEqual(0);
        expect(record.span, golden.id).toBeDefined();
      }
    }
  });
});

describe('fix gate', () => {
  it('fixes at least 90% of the targeted findings', () => {
    const { fixes } = run.report;
    const missed = fixes.verdicts
      .filter((v) => v.verdict !== 'fixed' && v.verdict !== 'review')
      .map((v) => `${v.finding}: ${v.verdict}`);
    expect(fixes.targeted).toBeGreaterThanOrEqual(30);
    expect(fixes.fixRate, lines(missed)).toBeGreaterThanOrEqual(FIX_RATE_GATE);
  });

  it('reaches the bar in each theme-patched top-six category on its own', () => {
    const rows = categoryRows(run.findings);
    // Media alt text is fixed through the Admin API, not by a theme patch: it is reviewed, never scored.
    for (const category of TOP_SIX_CATEGORIES.filter((c) => c !== 'alt-text-media')) {
      const row = rows.find((r) => r.category === category);
      expect(row?.targeted ?? 0, category).toBeGreaterThan(0);
      expect(row?.fixRate ?? 0, category).toBeGreaterThanOrEqual(FIX_RATE_GATE);
      expect(row?.mappingAccuracy ?? 0, category).toBeGreaterThanOrEqual(MAPPING_ACCURACY_GATE);
    }
  });

  it('refuses, and applies nothing for, exactly the findings whose golden says refused', () => {
    expect(
      run.report.fixes.unexpected,
      lines(run.report.fixes.unexpected.map((u) => u.finding)),
    ).toEqual([]);
  });

  it('has no render regression: axe sees no new result and nothing vanished', () => {
    expect(run.report.regressions, JSON.stringify(run.report.regressions, null, 2)).toEqual([]);
    for (const theme of run.themes) {
      for (const page of theme.after) {
        expect(page.rendered, `${theme.theme}/${page.page}`).toBe(true);
      }
    }
  });

  it('keeps every element, attribute and text of every page: patches only add (stricter than axe)', () => {
    expect(run.domViolations, lines(run.domViolations)).toEqual([]);
    // The check sees the patches: the pages gained elements (labels, skip links, names).
    const added = run.themes.flatMap((t) => Object.values(t.addedElements));
    expect(added.length).toBeGreaterThan(0);
    expect(added.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it('introduces no Theme Check offense in any patched theme', () => {
    for (const theme of run.themes) {
      expect(theme.newThemeCheckOffenses, theme.theme).toEqual([]);
      expect(Object.keys(theme.diffs).length, theme.theme).toBeGreaterThan(0);
    }
  });

  it('passes both gates', () => {
    expect(run.report.gates).toEqual({ mapping: true, fixes: true });
    expect(run.report.passed).toBe(true);
  });
});

describe('the gates can fail', () => {
  it('fails the fix gate without the contrast recipe, as WS-11 measured', () => {
    const { fixes, gates } = withoutContrast.report;
    expect(fixes.fixRate).toBeLessThan(FIX_RATE_GATE);
    const contrast = withoutContrast.goldens.filter(
      (g) => g.expectedFix.targeted && g.expectedFix.recipe === 'contrast',
    ).length;
    expect(contrast).toBeGreaterThan(0);
    expect(fixes.fixed).toBe(fixes.targeted - contrast);
    expect(gates.fixes).toBe(false);
  });
});

describe('records and report', () => {
  it('emit records that validate against the contract schema', () => {
    const records = runnerRecords(run, '0000000');
    expect(validate('runner-records', JSON.parse(JSON.stringify(records)))).toEqual([]);
  });

  it('emit a report that validates against the contract schema', () => {
    expect(validate('runner-report', JSON.parse(JSON.stringify(run.report)))).toEqual([]);
  });

  it('count every finding of the failing themes in the category table', () => {
    const rows = categoryRows(run.findings);
    const total = rows.find((r) => r.category === 'all');
    expect(total?.findings).toBe(run.findings.length);
    expect(total?.mappedCorrectly).toBe(run.report.mapping.correct);
    expect(total?.fixed).toBe(run.report.fixes.fixed);
    expect(rows.slice(0, -1).reduce((sum, r) => sum + r.findings, 0)).toBe(total?.findings);
  });
});
