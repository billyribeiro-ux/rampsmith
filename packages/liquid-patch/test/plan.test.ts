/**
 * The planner (ADR-248): which recipe a rule runs, what the engine supplies and what the caller
 * must bring, and the typed refusals for a span of the wrong kind or a missing parameter.
 */
import { describe, expect, it } from 'vitest';
import { hasRecipe, planFix, type FixRequest } from '../src/plan.ts';
import { applyEdits } from '../src/edits.ts';
import type { MappedSpan } from '../src/map/types.ts';
import { at } from './tarn.ts';

const LAYOUT = `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/x"></a>\n<img src="/a.png">\n<button></button>\n<input name="q">\n<main id="MainContent"></main>\n</body>\n</html>\n`;
const FILE = 'layout/theme.liquid';

function element(marker: string, tag: string): MappedSpan {
  return { kind: 'element', file: FILE, start: at(LAYOUT, marker), tag };
}

function request(rule: string, span: MappedSpan, extra: Partial<FixRequest> = {}): FixRequest {
  return { rule, span, files: new Map([[FILE, LAYOUT]]), ...extra };
}

function applied(outcome: ReturnType<typeof planFix>): string {
  if (outcome?.kind !== 'edits') throw new Error(JSON.stringify(outcome));
  const result = applyEdits(LAYOUT, outcome.edits);
  if (!result.ok) throw new Error(result.error.message);
  return result.contents;
}

describe('hasRecipe', () => {
  it('knows the rules the engine fixes', () => {
    for (const rule of [
      'html-has-lang',
      'html-lang-valid',
      'image-alt',
      'label',
      'select-name',
      'link-name',
      'button-name',
      'bypass',
      'color-contrast',
    ]) {
      expect(hasRecipe(rule), rule).toBe(true);
    }
    expect(hasRecipe('target-size')).toBe(false);
    expect(hasRecipe('rs-focus-indicator-missing')).toBe(false);
  });
});

describe('planFix on elements', () => {
  it('sets the document language without any parameter', () => {
    const out = planFix(request('html-has-lang', element('<html>', 'html')));
    expect(applied(out)).toContain('<html lang="{{ request.locale.iso_code }}">');
  });

  it('marks an image decorative only when the caller says so', () => {
    const span = element('<img', 'img');
    expect(planFix(request('image-alt', span))?.kind).toBe('refusal');
    const out = planFix(request('image-alt', span, { params: { decorative: { reason: 'logo' } } }));
    expect(applied(out)).toContain('alt=""');
  });

  it('needs a label for links, buttons and form controls, and uses it', () => {
    const label = { key: 'accessibility.go', text: 'Go' };
    for (const [rule, marker, tag] of [
      ['link-name', '<a href="/x">', 'a'],
      ['button-name', '<button>', 'button'],
      ['label', '<input name="q">', 'input'],
    ] as const) {
      const span = element(marker, tag);
      const missing = planFix(request(rule, span));
      expect(missing, rule).toMatchObject({ kind: 'refusal', code: 'invalid-parameter' });
      const out = planFix(request(rule, span, { params: { label } }));
      expect(out?.kind, rule).toBe('edits');
      if (out?.kind === 'edits') expect(out.translations).toContainEqual(label);
    }
  });

  it('passes the id and visually hidden class to the recipes that take them', () => {
    const label = { key: 'accessibility.search', text: 'Search' };
    const out = planFix(
      request('label', element('<input name="q">', 'input'), {
        params: { label, id: 'q-{{ section.id }}', visuallyHiddenClass: 'sr-only' },
      }),
    );
    const text = applied(out);
    expect(text).toContain('id="q-{{ section.id }}"');
    expect(text).toContain('class="sr-only"');
  });

  it('adds a skip link with or without a caller label', () => {
    expect(planFix(request('bypass', element('<body>', 'body')))?.kind).toBe('edits');
    const label = { key: 'accessibility.skip', text: 'Skip to content' };
    expect(planFix(request('bypass', element('<body>', 'body'), { params: { label } }))?.kind).toBe(
      'edits',
    );
  });

  it('returns null for a rule without a recipe', () => {
    expect(planFix(request('target-size', element('<a href="/x">', 'a')))).toBeNull();
  });

  it('refuses a span that is not an element, or a file that is not in the theme', () => {
    const json: MappedSpan = {
      kind: 'json-value',
      file: 'a.json',
      pointer: '/x',
      start: 0,
      end: 1,
    };
    expect(planFix(request('image-alt', json))).toMatchObject({
      kind: 'refusal',
      code: 'wrong-element',
    });
    const missing: MappedSpan = {
      kind: 'element',
      file: 'sections/none.liquid',
      start: 0,
      tag: 'a',
    };
    expect(planFix(request('link-name', missing))).toMatchObject({
      kind: 'refusal',
      code: 'wrong-file',
    });
  });

  it('refuses a file that does not parse', () => {
    const broken = new Map([[FILE, '<div>{% if %}</div>']]);
    const out = planFix({
      rule: 'html-has-lang',
      span: { kind: 'element', file: FILE, start: 0, tag: 'html' },
      files: broken,
    });
    expect(out).toMatchObject({ kind: 'refusal', code: 'wrong-file' });
  });
});

describe('planFix on contrast', () => {
  const SETTINGS = '{\n  "current": { "color_muted": "#9b9b9b" }\n}\n';
  const span: MappedSpan = {
    kind: 'json-value',
    file: 'config/settings_data.json',
    pointer: '/current/color_muted',
    start: SETTINGS.indexOf('"#9b9b9b"'),
    end: SETTINGS.indexOf('"#9b9b9b"') + 9,
  };
  const files = new Map([['config/settings_data.json', SETTINGS]]);
  const evidence = { background: '#ffffff', fontSizePx: 16, bold: false };

  it('applies the nearest candidate by default and the stronger one on request', () => {
    const nearest = planFix({ rule: 'color-contrast', span, files, contrast: evidence });
    const stronger = planFix({
      rule: 'color-contrast',
      span,
      files,
      contrast: evidence,
      candidate: 'stronger',
    });
    expect(nearest?.kind).toBe('edits');
    expect(stronger?.kind).toBe('edits');
    if (nearest?.kind === 'edits' && stronger?.kind === 'edits') {
      expect(nearest.edits[0]?.replacement).not.toBe(stronger.edits[0]?.replacement);
    }
  });

  it('judges large text by its size and weight', () => {
    const large = planFix({
      rule: 'color-contrast',
      span,
      files,
      contrast: { background: '#ffffff', fontSizePx: 30, bold: false },
    });
    const small = planFix({ rule: 'color-contrast', span, files, contrast: evidence });
    expect(large?.kind).toBe('edits');
    if (large?.kind === 'edits' && small?.kind === 'edits') {
      expect(large.edits[0]?.replacement).not.toBe(small.edits[0]?.replacement);
    }
  });

  it('needs the measured background, a colour span and a file that is there', () => {
    expect(planFix({ rule: 'color-contrast', span, files })).toMatchObject({
      kind: 'refusal',
      code: 'invalid-parameter',
    });
    expect(
      planFix({
        rule: 'color-contrast',
        span: { kind: 'element', file: FILE, start: 0, tag: 'p' },
        files,
        contrast: evidence,
      }),
    ).toMatchObject({ kind: 'refusal', code: 'wrong-element' });
    expect(
      planFix({ rule: 'color-contrast', span, files: new Map(), contrast: evidence }),
    ).toMatchObject({ kind: 'refusal', code: 'wrong-file' });
  });
});
