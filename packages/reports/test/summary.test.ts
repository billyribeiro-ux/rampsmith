import { describe, expect, it } from 'vitest';
import { passRate, renderSummary, ReportInputError } from '../src/index.ts';
import { PALETTE } from '../src/document.ts';
import { summaryInput } from './fixtures.ts';

/** WCAG 2.2 relative luminance and contrast ratio of two sRGB hex colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('palette', () => {
  it('gives text at least 4.5:1 against the page', () => {
    for (const key of ['text', 'muted', 'accent'] as const) {
      expect(contrast(PALETTE[key], PALETTE.page), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives chart marks and rules at least 3:1 against the page (1.4.11)', () => {
    for (const key of ['rule', 'accent', 'critical', 'serious', 'moderate', 'minor'] as const) {
      expect(contrast(PALETTE[key], PALETTE.page), key).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('renderSummary', () => {
  const html = renderSummary(summaryInput()).document.html;

  it('states the latest result as passed N of M automated checks', () => {
    expect(html).toContain(
      'Latest scan, October 16, 2026: passed 1,198 of 1,250 automated WCAG 2.2 Level AA checks (95.8%).',
    );
    expect(html).toContain('20 open findings');
    expect(html).toContain('128 fixes verified in this period');
  });

  it('describes the trend in text and names each chart by its caption and summary', () => {
    expect(html).toContain(
      'Line chart of 7 scans from September 4, 2026 to October 16, 2026. The pass rate went from 85% to 95.8%, with a low of 85% and a high of 96%.',
    );
    expect(html).toContain('aria-labelledby="pass-rate-caption pass-rate-summary"');
    expect(html).toContain('<p id="pass-rate-summary">');
    expect(html).toContain('aria-labelledby="impact-caption impact-summary"');
  });

  it('follows each chart with a data table holding the same numbers', () => {
    expect(html).toContain(
      '<tr><th scope="row">September 4, 2026</th><td class="num">1,003</td><td class="num">1,180</td><td class="num">85%</td></tr>',
    );
    expect(html).toContain('<tr><th scope="row">Critical</th><td class="num">1</td></tr>');
    expect(html).toContain('<tr><th scope="row">Total</th><td class="num">20</td></tr>');
  });

  it('carries the coverage disclosure and the limits of automated testing', () => {
    expect(html).toContain('<h2>What the automated checks cover</h2>');
    expect(html).toContain('finds on average 57% of WCAG issues');
  });

  it('plots scans in date order whatever the input order', () => {
    const scans = [...summaryInput().scans].reverse();
    const reordered = renderSummary(summaryInput({ scans })).document.html;
    expect(reordered).toBe(html);
  });

  it('says so when no scan has finished', () => {
    const empty = renderSummary(summaryInput({ scans: [] })).document.html;
    expect(empty).toContain('No scan has finished yet, so there are no results to show.');
    expect(empty).not.toContain('pass-rate-summary');
  });

  it('computes the pass rate as passed over run', () => {
    expect(passRate({ passed: 3, run: 4 })).toBe(0.75);
    expect(passRate({ passed: 0, run: 0 })).toBe(0);
  });

  it.each([
    [
      { scans: [{ finishedAt: new Date(), checksRun: 1, checksPassed: 2 }] },
      'scans[0].checksPassed',
    ],
    [{ scans: [{ finishedAt: new Date(), checksRun: 0, checksPassed: 0 }] }, 'scans[0].checksRun'],
    [
      { scans: [{ finishedAt: new Date('x'), checksRun: 1, checksPassed: 1 }] },
      'scans[0].finishedAt',
    ],
    [
      { openFindings: { critical: -1, serious: 0, moderate: 0, minor: 0 } },
      'openFindings.critical',
    ],
    [
      { openFindings: { critical: 0.5, serious: 0, moderate: 0, minor: 0 } },
      'openFindings.critical',
    ],
    [{ period: { from: new Date('2026-10-02'), to: new Date('2026-10-01') } }, 'period'],
    [{ site: { name: 'x', url: 'ftp://x.example', platform: 'shopify' as const } }, 'site.url'],
  ])('%#: refuses a bad %s', (override, field) => {
    let error: unknown;
    try {
      renderSummary(summaryInput(override));
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReportInputError);
    expect((error as ReportInputError).field).toBe(field);
  });
});
