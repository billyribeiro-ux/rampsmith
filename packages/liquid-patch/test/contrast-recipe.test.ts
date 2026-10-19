/**
 * The contrast recipe on theme JSON settings and on CSS (ADR-242, ADR-243): it edits only the
 * colour value, offers two candidates, is a no-op on its own output, and refuses what it
 * cannot judge. The sources are written by hand for these tests.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor } from '../src/color/color.ts';
import { applyEdits, mapOffset } from '../src/edits.ts';
import {
  chooseCandidate,
  contrast,
  type ColorSpan,
  type ContrastOutcome,
  type ContrastParams,
} from '../src/recipes/contrast.ts';
import { expectBytesKept, startOf } from './helpers.ts';

const SETTINGS = `{
  /* Saved by the theme editor. */
  "current": {
    "color_text": "#1f1f1f",
    "color_muted": "#9B9B9B",
    "sections": { "announcement": { "settings": { "text_color": "rgb(160, 160, 160)" } } },
    "palette": ["#fff", "#a0a0a0"]
  },
  "presets": {
    "Default": { "color_muted": "#5c5c5c" }
  }
}
`;

const SETTINGS_FILE = 'config/settings_data.json';
const WHITE = { background: '#ffffff' } as const satisfies ContrastParams;

function jsonSpan(pointer: string): ColorSpan {
  return { kind: 'json-value', file: SETTINGS_FILE, pointer };
}

function candidatesOf(outcome: ContrastOutcome) {
  if (outcome.kind !== 'candidates') throw new Error(JSON.stringify(outcome));
  return outcome.candidates;
}

describe('contrast on a JSON setting', () => {
  it('replaces only the colour inside the quotes, keeping case style and every other byte', () => {
    const outcome = contrast.run(SETTINGS, jsonSpan('/current/color_muted'), WHITE);
    const [nearest, stronger] = candidatesOf(outcome);
    expect(nearest?.id).toBe('nearest');
    expect(stronger?.id).toBe('stronger');
    expect(nearest?.color).toMatch(/^#[0-9A-F]{6}$/u);
    const applied = applyEdits(SETTINGS, nearest?.edits ?? []);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.contents).toBe(SETTINGS.replace('"#9B9B9B"', `"${nearest?.color ?? ''}"`));
    expectBytesKept(SETTINGS, nearest?.edits ?? [], applied.contents);
    // The comment and the preset's own colour are untouched.
    expect(applied.contents).toContain('/* Saved by the theme editor. */');
    expect(applied.contents).toContain('"Default": { "color_muted": "#5c5c5c" }');
  });

  it('reads the span from the pointer when offsets are not given, and checks them when they are', () => {
    const start = startOf(SETTINGS, '"#9B9B9B"');
    const good: ColorSpan = {
      kind: 'json-value',
      file: SETTINGS_FILE,
      pointer: '/current/color_muted',
      start,
      end: start + '"#9B9B9B"'.length,
    };
    expect(contrast.run(SETTINGS, good, WHITE).kind).toBe('candidates');
    const stale: ColorSpan = { ...good, start: start + 1 };
    expect(contrast.run(SETTINGS, stale, WHITE)).toMatchObject({
      kind: 'refusal',
      code: 'target-not-found',
    });
  });

  it('handles a nested section setting, an rgb() colour and an array element', () => {
    const nested = contrast.run(
      SETTINGS,
      jsonSpan('/current/sections/announcement/settings/text_color'),
      WHITE,
    );
    expect(candidatesOf(nested)[0]?.color).toMatch(/^rgb\(\d+, \d+, \d+\)$/u);
    const element = contrast.run(SETTINGS, jsonSpan('/current/palette/1'), WHITE);
    expect(candidatesOf(element)[0]?.color).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it('is a no-op on its own output: the fixed value is already-fixed', () => {
    const first = candidatesOf(contrast.run(SETTINGS, jsonSpan('/current/color_muted'), WHITE));
    for (const candidate of first) {
      const applied = applyEdits(SETTINGS, candidate.edits);
      if (!applied.ok) throw new Error(applied.error.message);
      const again = contrast.run(applied.contents, jsonSpan('/current/color_muted'), WHITE);
      expect(again.kind, candidate.id).toBe('already-fixed');
      expect(parseColor(candidate.color)).not.toBeNull();
      expect(
        contrastRatio(parseColor(candidate.color)?.rgb ?? { r: 0, g: 0, b: 0 }, {
          r: 255,
          g: 255,
          b: 255,
        }),
      ).toBeGreaterThan(candidate.target);
    }
  });

  it('is already fixed when the colour passes, and uses 3:1 for large text', () => {
    expect(contrast.run(SETTINGS, jsonSpan('/current/color_text'), WHITE).kind).toBe(
      'already-fixed',
    );
    const body = candidatesOf(contrast.run(SETTINGS, jsonSpan('/current/color_muted'), WHITE));
    const large = candidatesOf(
      contrast.run(SETTINGS, jsonSpan('/current/color_muted'), { ...WHITE, large: true }),
    );
    expect(Math.abs(large[0]?.deltaL ?? 1)).toBeLessThan(Math.abs(body[0]?.deltaL ?? 0));
    const explicit = candidatesOf(
      contrast.run(SETTINGS, jsonSpan('/current/color_muted'), { ...WHITE, minimumRatio: 3 }),
    );
    expect(explicit[0]?.color).toBe(large[0]?.color);
  });

  it('refuses what is not one opaque literal colour', () => {
    const source = JSON.stringify({
      current: {
        a: 'var(--x)',
        b: '{{ settings.c }}',
        c: 'rgba(0, 0, 0, 0.4)',
        d: 12,
        e: 'linear-gradient(#fff, #000)',
        f: '#ab\\u0063def',
      },
    });
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      expect(
        contrast.run(
          source,
          { kind: 'json-value', file: SETTINGS_FILE, pointer: `/current/${key}` },
          WHITE,
        ),
        key,
      ).toMatchObject({ kind: 'refusal', code: 'unsupported-color' });
    }
    expect(
      contrast.run(
        source,
        { kind: 'json-value', file: SETTINGS_FILE, pointer: '/current/f' },
        WHITE,
      ),
    ).toMatchObject({ kind: 'refusal', code: 'unsupported-color' });
    expect(
      contrast.run(
        source,
        { kind: 'json-value', file: SETTINGS_FILE, pointer: '/current/missing' },
        WHITE,
      ),
    ).toMatchObject({ kind: 'refusal', code: 'target-not-found' });
  });

  it('refuses bad parameters, and a background no lightness can beat', () => {
    const span = jsonSpan('/current/color_muted');
    for (const params of [
      { background: 'var(--bg)' },
      { background: 'rgba(0,0,0,0.5)' },
      { background: '#fff', minimumRatio: 0.5 },
      { background: '#fff', minimumRatio: 21 },
    ] satisfies ContrastParams[]) {
      expect(contrast.run(SETTINGS, span, params), JSON.stringify(params)).toMatchObject({
        kind: 'refusal',
        code: 'invalid-parameter',
      });
    }
    expect(contrast.run(SETTINGS, span, { background: '#777777', minimumRatio: 20 })).toMatchObject(
      {
        kind: 'refusal',
        code: 'contrast-unreachable',
      },
    );
  });
});

describe('contrast on CSS', () => {
  const CSS = `.card__vendor {
  margin: 0;
  color: #a8a8a8;
  font-size: 14px;
}

.card__note { color:#9e9e9e!important; background: #fff }
.card__hint { COLOR : rgb(150 150 150) ; }
.card__var { color: var(--muted); }
.card__fade { color: rgba(0, 0, 0, 0.3); }
`;

  function cssSpan(declaration: string, property = 'color', source = CSS): ColorSpan {
    const start = startOf(source, declaration);
    return {
      kind: 'css-declaration',
      file: 'assets/base.css',
      property,
      start,
      end: start + declaration.length,
    };
  }

  it('replaces only the value of the declaration', () => {
    const span = cssSpan('color: #a8a8a8');
    const [nearest] = candidatesOf(contrast.run(CSS, span, WHITE));
    const applied = applyEdits(CSS, nearest?.edits ?? []);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.contents).toBe(
      CSS.replace('color: #a8a8a8;', `color: ${nearest?.color ?? ''};`),
    );
    expectBytesKept(CSS, nearest?.edits ?? [], applied.contents);
    expect(nearest?.color).toBe('#767676');
  });

  it('keeps !important, odd spacing, a different case of the property and the rgb() syntax', () => {
    const important = candidatesOf(contrast.run(CSS, cssSpan('color:#9e9e9e!important'), WHITE))[0];
    const applied = applyEdits(CSS, important?.edits ?? []);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.contents).toContain(`color:${important?.color ?? ''}!important;`);
    const spaced = candidatesOf(contrast.run(CSS, cssSpan('COLOR : rgb(150 150 150)'), WHITE))[0];
    expect(spaced?.color).toMatch(/^rgb\(\d+ \d+ \d+\)$/u);
    const applied2 = applyEdits(CSS, spaced?.edits ?? []);
    if (!applied2.ok) throw new Error(applied2.error.message);
    expect(applied2.contents).toContain(`COLOR : ${spaced?.color ?? ''} ;`);
  });

  it('is a no-op on its own output', () => {
    const span = cssSpan('color: #a8a8a8');
    const first = candidatesOf(contrast.run(CSS, span, WHITE));
    expect(first).toHaveLength(2);
    for (const candidate of first) {
      const applied = applyEdits(CSS, candidate.edits);
      if (!applied.ok) throw new Error(applied.error.message);
      const moved =
        mapOffset(span.kind === 'css-declaration' ? span.start : 0, candidate.edits) ?? 0;
      const length = 'color: '.length + candidate.color.length;
      const again = contrast.run(
        applied.contents,
        { ...span, start: moved, end: moved + length },
        WHITE,
      );
      expect(again.kind, candidate.id).toBe('already-fixed');
    }
  });

  it('refuses var(), Liquid output, transparent colours, another property, and a stale span', () => {
    for (const declaration of ['color: var(--muted)', 'color: rgba(0, 0, 0, 0.3)']) {
      expect(contrast.run(CSS, cssSpan(declaration), WHITE), declaration).toMatchObject({
        kind: 'refusal',
        code: 'unsupported-color',
      });
    }
    expect(contrast.run(CSS, cssSpan('color: #a8a8a8', 'background-color'), WHITE)).toMatchObject({
      kind: 'refusal',
      code: 'target-not-found',
    });
    expect(
      contrast.run(
        CSS,
        { kind: 'css-declaration', file: 'assets/base.css', property: 'color', start: 0, end: 5 },
        WHITE,
      ),
    ).toMatchObject({ kind: 'refusal', code: 'target-not-found' });
    expect(
      contrast.run(
        CSS,
        {
          kind: 'css-declaration',
          file: 'assets/base.css',
          property: 'color',
          start: 10,
          end: 99999,
        },
        WHITE,
      ),
    ).toMatchObject({ kind: 'refusal', code: 'target-not-found' });
  });

  it('refuses Liquid output in a .css.liquid asset', () => {
    const asset = '.card { color: {{ settings.color_muted }}; }\n';
    const start = startOf(asset, 'color: {{ settings.color_muted }}');
    expect(
      contrast.run(
        asset,
        {
          kind: 'css-declaration',
          file: 'assets/theme.css.liquid',
          property: 'color',
          start,
          end: start + 'color: {{ settings.color_muted }}'.length,
        },
        WHITE,
      ),
    ).toMatchObject({ kind: 'refusal', code: 'unsupported-color' });
  });

  it('works in a Liquid file: the {% stylesheet %} of a section', () => {
    const section = `{% stylesheet %}\n  .note { color: #9e9e9e; }\n{% endstylesheet %}\n<p class="note">x</p>\n`;
    const span: ColorSpan = {
      kind: 'css-declaration',
      file: 'sections/newsletter.liquid',
      property: 'color',
      start: startOf(section, 'color: #9e9e9e'),
      end: startOf(section, 'color: #9e9e9e') + 'color: #9e9e9e'.length,
    };
    const [nearest] = candidatesOf(contrast.run(section, span, WHITE));
    const applied = applyEdits(section, nearest?.edits ?? []);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.contents).toContain(`.note { color: ${nearest?.color ?? ''}; }`);
  });
});

describe('chooseCandidate', () => {
  it('turns the chosen candidate into edits and notes, and passes the other outcomes through', () => {
    const outcome = contrast.run(SETTINGS, jsonSpan('/current/color_muted'), WHITE);
    const nearest = chooseCandidate(outcome);
    expect(nearest).toMatchObject({ kind: 'edits', translations: [] });
    if (nearest.kind !== 'edits') return;
    expect(nearest.edits).toHaveLength(1);
    expect(nearest.notes[0]).toMatch(
      /^contrast: #9B9B9B \(\d\.\d\d:1\) to #[0-9A-F]{6} \(4\.\d\d:1\), nearest$/u,
    );
    const stronger = chooseCandidate(outcome, 'stronger');
    expect(stronger.kind === 'edits' ? stronger.edits[0]?.replacement : '').not.toBe(
      nearest.edits[0]?.replacement,
    );
    expect(
      chooseCandidate(contrast.run(SETTINGS, jsonSpan('/current/color_text'), WHITE)).kind,
    ).toBe('already-fixed');
    expect(chooseCandidate(contrast.run(SETTINGS, jsonSpan('/current/nope'), WHITE)).kind).toBe(
      'refusal',
    );
  });

  it('refuses a candidate that was not offered', () => {
    const outcome = contrast.run(
      '{"c": "#9b9b9b"}',
      { kind: 'json-value', file: 'x.json', pointer: '/c' },
      { background: '#ffffff', minimumRatio: 7 },
    );
    expect(chooseCandidate(outcome, 'stronger')).toMatchObject({
      kind: 'refusal',
      code: 'invalid-parameter',
    });
    expect(chooseCandidate(outcome).kind).toBe('edits');
  });
});
