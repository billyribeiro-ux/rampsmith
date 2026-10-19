// Budgets the embed must keep (PLAN §14, §23): under 5 KB of deferred JavaScript, loaded only
// with the form; small inline CSS; fixed colour schemes at WCAG 2.2 AA contrast.
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contrast } from '../src/contrast.ts';
import { SCRIPT_FILE, STYLES_FILE } from '../src/paths.ts';
import { renderEmbed } from '../src/render.ts';

const script = readFileSync(SCRIPT_FILE);
const styles = readFileSync(STYLES_FILE, 'utf8');
const css = /<style>([\s\S]*)<\/style>/u.exec(styles)?.[1] ?? '';

/** The script's budget, counted on the uncompressed file: the strictest reading of "5 KB". */
const SCRIPT_BUDGET_BYTES = 5 * 1024;

describe('JavaScript budget', () => {
  it('ships under 5 KB uncompressed, and far less on the wire', () => {
    expect(script.byteLength).toBeLessThan(SCRIPT_BUDGET_BYTES);
    expect(gzipSync(script, { level: 9 }).byteLength).toBeLessThan(2 * 1024);
    expect(
      brotliCompressSync(script, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    ).toBeLessThan(2 * 1024);
  });

  it('loads no JavaScript at all unless the merchant shows the form', async () => {
    expect(await renderEmbed({ statementMetafield: '/pages/a' })).not.toContain('<script');
    expect(await renderEmbed({ designMode: true })).not.toContain('<script');
  });

  it('loads the one script with defer, never parser-blocking', async () => {
    const html = await renderEmbed({ settings: { show_report_form: true } });
    const tags = html.match(/<script\b[^>]*>/gu) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/\sdefer>$/u);
  });
});

describe('page weight', () => {
  it('inlines under 2 KB of CSS and keeps the whole embed small', async () => {
    expect(Buffer.byteLength(css, 'utf8')).toBeLessThan(2 * 1024);
    const linkOnly = await renderEmbed({ statementMetafield: '/pages/a' });
    const withForm = await renderEmbed({
      statementMetafield: '/pages/a',
      settings: { show_report_form: true },
    });
    expect(Buffer.byteLength(linkOnly, 'utf8')).toBeLessThan(3 * 1024);
    expect(Buffer.byteLength(withForm, 'utf8')).toBeLessThan(8 * 1024);
  });
});

describe('fixed colour schemes', () => {
  const colour = (selector: string, property: 'color' | 'background'): string => {
    const rule =
      new RegExp(`${selector.replaceAll('.', '\\.')}\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
    const value = new RegExp(`(?:^|;)${property}:(#[0-9a-f]{3,6})`, 'iu').exec(rule)?.[1];
    if (value === undefined) throw new Error(`${selector} has no ${property}`);
    return value;
  };

  it('pass 4.5:1 for text and errors, and so 3:1 for the currentColor borders and focus rings', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const background = colour(`.rs-a11y--${scheme}`, 'background');
      const text = colour(`.rs-a11y--${scheme}`, 'color');
      const error = colour(`.rs-a11y--${scheme} .rs-a11y__error`, 'color');
      expect(contrast(text, background), `${scheme} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(error, background), `${scheme} error`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('computes contrast as WCAG defines it', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
  });

  it('draws control borders and focus rings in currentColor, so they follow the text', () => {
    expect(css).toMatch(/\.rs-a11y__control\{[^}]*border:1px solid currentColor/u);
    expect(css).toMatch(/:focus-visible\{outline:3px solid currentColor/u);
  });
});
