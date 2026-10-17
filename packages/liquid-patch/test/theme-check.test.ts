import type { ThemeDocset } from '@shopify/theme-check-common';
import { describe, expect, it } from 'vitest';
import { OFFLINE_CHECKS, themeOffenses, validateNoNewOffenses } from '../src/theme-check.ts';
import { localeEdits } from '../src/translations.ts';
import { applyEdits } from '../src/edits.ts';
import { dawnTheme } from './dawn.ts';

const LAYOUT = 'layout/theme.liquid';

function withFile(theme: Map<string, string>, path: string, source: string): Map<string, string> {
  return new Map([...theme, [path, source]]);
}

function addToLayout(theme: Map<string, string>, markup: string): Map<string, string> {
  const layout = theme.get(LAYOUT) ?? '';
  return withFile(theme, LAYOUT, layout.replace('  </body>', `    ${markup}\n  </body>`));
}

describe('OFFLINE_CHECKS', () => {
  it("is Shopify's recommended set without the checks that fetch remote assets", () => {
    const codes = OFFLINE_CHECKS.map((c) => c.meta.code);
    expect(codes.length).toBeGreaterThan(50);
    expect(codes).toContain('LiquidHTMLSyntaxError');
    expect(codes).toContain('TranslationKeyExists');
    expect(codes).toContain('MatchingTranslations');
    expect(codes).not.toContain('AssetSizeCSS');
    expect(codes).not.toContain('AssetSizeJavaScript');
  });
});

describe('themeOffenses', () => {
  it('runs in memory on the Dawn fixtures with no crashed check and no translation offense', async () => {
    const offenses = await themeOffenses(dawnTheme());
    expect(offenses.filter((o) => o.check === 'CheckCrashed')).toEqual([]);
    expect(
      offenses.filter((o) => ['TranslationKeyExists', 'MatchingTranslations'].includes(o.check)),
    ).toEqual([]);
    // Only part of Dawn is vendored, so references to the rest are reported.
    expect(offenses.some((o) => o.check === 'MissingAsset')).toBe(true);
  });
});

describe('validateNoNewOffenses', () => {
  const dawn = dawnTheme();

  it('passes when nothing changed', async () => {
    expect(await validateNoNewOffenses(dawn, dawn)).toEqual({ ok: true, newOffenses: [] });
  });

  it('reports a translation key missing from the default locale', async () => {
    const result = await validateNoNewOffenses(
      dawn,
      addToLayout(dawn, "<span>{{ 'rampsmith.missing' | t }}</span>"),
    );
    expect(result.ok).toBe(false);
    expect(result.newOffenses).toMatchObject([
      { file: LAYOUT, check: 'TranslationKeyExists', severity: 'error' },
    ]);
  });

  it('reports locales missing a key that only the default locale got, and passes once all have it', async () => {
    const used = addToLayout(dawn, "<span>{{ 'accessibility.rampsmith_test' | t }}</span>");
    const locales = ['locales/en.default.json', 'locales/de.json', 'locales/ja.json'].map(
      (path) => ({ path, source: dawn.get(path) ?? '' }),
    );
    const result = localeEdits(locales, [{ key: 'accessibility.rampsmith_test', text: 'Test' }]);
    if (!result.ok) throw new Error(result.error.message);
    const patchedLocales = new Map(
      locales.map((f) => {
        const applied = applyEdits(
          f.source,
          result.edits.filter((e) => e.file === f.path),
        );
        if (!applied.ok) throw new Error(applied.error.message);
        return [f.path, applied.contents] as const;
      }),
    );
    const defaultOnly = withFile(
      used,
      'locales/en.default.json',
      patchedLocales.get('locales/en.default.json') ?? '',
    );
    const partial = await validateNoNewOffenses(dawn, defaultOnly);
    expect(partial.ok).toBe(false);
    expect(new Set(partial.newOffenses.map((o) => `${o.check} ${o.file}`))).toEqual(
      new Set(['MatchingTranslations locales/de.json', 'MatchingTranslations locales/ja.json']),
    );
    const complete = new Map([...used, ...patchedLocales]);
    expect(await validateNoNewOffenses(dawn, complete)).toEqual({ ok: true, newOffenses: [] });
  });

  it('reports markup errors Theme Check knows, such as an image without dimensions', async () => {
    const result = await validateNoNewOffenses(
      dawn,
      addToLayout(dawn, '<img src="{{ settings.logo | image_url }}" alt="">'),
    );
    expect(result.newOffenses.map((o) => o.check)).toEqual(['ImgWidthAndHeight']);
  });

  it('counts warnings unless told not to', async () => {
    const after = addToLayout(dawn, '{% assign rampsmith_unused = 1 %}');
    const strict = await validateNoNewOffenses(dawn, after);
    expect(strict.newOffenses).toMatchObject([{ check: 'UnusedAssign', severity: 'warning' }]);
    expect(await validateNoNewOffenses(dawn, after, { includeWarnings: false })).toEqual({
      ok: true,
      newOffenses: [],
    });
  });

  it("passes Shopify's Liquid reference through to the checks that need it", async () => {
    const docset: ThemeDocset = {
      filters: () => Promise.resolve([{ name: 't' }, { name: 'escape' }]),
      objects: () => Promise.resolve([]),
      liquidDrops: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      systemTranslations: () => Promise.resolve({}),
    };
    const before = new Map([['snippets/a.liquid', '<p>{{ x | escape }}</p>']]);
    const after = new Map([['snippets/a.liquid', '<p>{{ x | rampsmith_nope }}</p>']]);
    expect((await validateNoNewOffenses(before, after)).ok).toBe(true);
    const withDocs = await validateNoNewOffenses(before, after, { themeDocset: docset });
    expect(withDocs.newOffenses.map((o) => o.check)).toContain('UnknownFilter');
  });
});
