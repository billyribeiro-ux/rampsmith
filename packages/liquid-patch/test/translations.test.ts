import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdits, type Edit } from '../src/edits.ts';
import {
  localeEdits,
  translationKeyProblem,
  translationOutput,
  translationTextProblem,
  type LocaleFile,
  type LocaleText,
} from '../src/translations.ts';
import { readDawn } from './dawn.ts';

function apply(files: readonly LocaleFile[], edits: readonly Edit[]): LocaleFile[] {
  return files.map((f) => {
    const mine = edits.filter((e) => e.file === f.path);
    const result = applyEdits(f.source, mine);
    if (!result.ok) throw new Error(`${f.path}: ${result.error.message}`);
    return { path: f.path, source: result.contents };
  });
}

function edited(files: readonly LocaleFile[], entries: readonly LocaleText[]): LocaleFile[] {
  const result = localeEdits(files, entries);
  if (!result.ok) throw new Error(result.error.message);
  return apply(files, result.edits);
}

describe('translation keys and texts', () => {
  it('accepts dotted snake-case keys and refuses others', () => {
    expect(translationKeyProblem('accessibility.skip_to_text')).toBeNull();
    expect(translationKeyProblem('general.social.links.facebook')).toBeNull();
    expect(translationKeyProblem('single')).not.toBeNull();
    expect(translationKeyProblem("a.b'c")).not.toBeNull();
    expect(translationKeyProblem('Accessibility.close')).not.toBeNull();
    expect(translationKeyProblem('a..b')).not.toBeNull();
    expect(translationKeyProblem('accessibility.label_html')).toMatch(/_html/u);
  });

  it('refuses empty texts, Liquid braces and control characters', () => {
    expect(translationTextProblem('Skip to content')).toBeNull();
    expect(translationTextProblem('  ')).not.toBeNull();
    expect(translationTextProblem('Hi {{ name }}')).not.toBeNull();
    expect(translationTextProblem('a\nb')).not.toBeNull();
  });

  it('prints a translation with the t filter', () => {
    expect(translationOutput('accessibility.close')).toBe("{{ 'accessibility.close' | t }}");
  });
});

const EN = {
  path: 'locales/en.default.json',
  source:
    '{\n  "general": {\n    "search": "Search"\n  },\n  "accessibility": {\n    "close": "Close"\n  }\n}\n',
};
const DE = {
  path: 'locales/de.json',
  source:
    '{\n  "general": {\n    "search": "Suchen"\n  },\n  "accessibility": {\n    "close": "Schließen"\n  }\n}\n',
};
const SCHEMA = { path: 'locales/en.default.schema.json', source: '{ "settings": {} }' };

describe('localeEdits', () => {
  it('adds a key to every storefront locale file and never touches schema locale files', () => {
    const result = localeEdits(
      [EN, DE, SCHEMA],
      [{ key: 'accessibility.skip_to_text', text: 'Skip to content' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.edits.map((e) => e.file))).toEqual(new Set([EN.path, DE.path]));
    expect(result.edits.every((e) => e.start === e.end)).toBe(true);
    const [en, de] = apply([EN, DE], result.edits);
    expect(en?.source).toBe(
      '{\n  "general": {\n    "search": "Search"\n  },\n  "accessibility": {\n    "close": "Close",\n    "skip_to_text": "Skip to content"\n  }\n}\n',
    );
    expect(JSON.parse(de?.source ?? '')).toMatchObject({
      accessibility: { skip_to_text: 'Skip to content' },
    });
    expect(result.untranslated).toEqual([{ file: DE.path, key: 'accessibility.skip_to_text' }]);
  });

  it('is idempotent: a key that exists is left alone', () => {
    const once = edited([EN, DE], [{ key: 'accessibility.skip_to_text', text: 'Skip to content' }]);
    const again = localeEdits(once, [
      { key: 'accessibility.skip_to_text', text: 'Something else' },
    ]);
    expect(again).toEqual({ ok: true, edits: [], untranslated: [] });
  });

  it('creates missing parent objects in the file layout', () => {
    const [en] = edited([EN], [{ key: 'rampsmith.labels.cart', text: 'Cart' }]);
    expect(en?.source).toBe(
      '{\n  "general": {\n    "search": "Search"\n  },\n  "accessibility": {\n    "close": "Close"\n  },\n  "rampsmith": {\n    "labels": {\n      "cart": "Cart"\n    }\n  }\n}\n',
    );
  });

  it('combines several keys under one object into one insertion', () => {
    const result = localeEdits(
      [EN],
      [
        { key: 'rampsmith.labels.cart', text: 'Cart' },
        { key: 'rampsmith.labels.account', text: 'Account' },
        { key: 'accessibility.open', text: 'Open' },
      ],
    );
    expect(result.ok && result.edits.length).toBe(2);
    const [en] = edited(
      [EN],
      [
        { key: 'rampsmith.labels.cart', text: 'Cart' },
        { key: 'rampsmith.labels.account', text: 'Account' },
      ],
    );
    expect(JSON.parse(en?.source ?? '')).toMatchObject({
      rampsmith: { labels: { cart: 'Cart', account: 'Account' } },
    });
  });

  it('keeps tabs, four-space indents, CRLF line endings and one-line objects as they are', () => {
    const tabs = {
      path: 'locales/en.default.json',
      source: '{\r\n\t"a": {\r\n\t\t"b": "c"\r\n\t}\r\n}',
    };
    const [t] = edited([tabs], [{ key: 'a.d', text: 'D' }]);
    expect(t?.source).toBe('{\r\n\t"a": {\r\n\t\t"b": "c",\r\n\t\t"d": "D"\r\n\t}\r\n}');

    const four = {
      path: 'locales/en.default.json',
      source: '{\n    "a": {\n        "b": "c"\n    }\n}\n',
    };
    const [f] = edited([four], [{ key: 'x.y', text: 'Y' }]);
    expect(f?.source).toBe(
      '{\n    "a": {\n        "b": "c"\n    },\n    "x": {\n        "y": "Y"\n    }\n}\n',
    );

    const inline = { path: 'locales/en.default.json', source: '{ "a": { "b": "c" } }' };
    const [i] = edited([inline], [{ key: 'a.d', text: 'D' }]);
    expect(i?.source).toBe('{ "a": { "b": "c", "d": "D" } }');
  });

  it('fills an empty object and an empty file object', () => {
    const empty = { path: 'locales/en.default.json', source: '{\n  "a": {}\n}\n' };
    const [e] = edited([empty], [{ key: 'a.b', text: 'B' }]);
    expect(JSON.parse(e?.source ?? '')).toEqual({ a: { b: 'B' } });
    const bare = { path: 'locales/en.default.json', source: '{}' };
    const [b] = edited([bare], [{ key: 'a.b', text: 'B' }]);
    expect(b?.source).toBe('{\n  "a": {\n    "b": "B"\n  }\n}');
  });

  it('keeps comments and escapes the text as JSON', () => {
    const commented = {
      path: 'locales/en.default.json',
      source: '/* auto */\n{\n  "a": {\n    "b": "c"\n  }\n}\n',
    };
    const [c] = edited([commented], [{ key: 'a.quote', text: 'Say "hi" \\ <b>' }]);
    expect(c?.source.startsWith('/* auto */\n')).toBe(true);
    expect(c?.source).toContain('"quote": "Say \\"hi\\" \\\\ <b>"');
  });

  it('uses supplied translations, falling back from a region to its base language', () => {
    const ptBr = { path: 'locales/pt-BR.json', source: '{\n  "a": {\n    "b": "c"\n  }\n}\n' };
    const enGb = { path: 'locales/en-GB.json', source: '{\n  "a": {\n    "b": "c"\n  }\n}\n' };
    const result = localeEdits(
      [EN, DE, ptBr, enGb],
      [
        {
          key: 'a.skip',
          text: 'Skip to content',
          byLocale: { de: 'Direkt zum Inhalt', pt: 'Pular para o conteúdo' },
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = apply([EN, DE, ptBr, enGb], result.edits);
    expect(out.map((f) => (JSON.parse(f.source) as { a: { skip: string } }).a.skip)).toEqual([
      'Skip to content',
      'Direkt zum Inhalt',
      'Pular para o conteúdo',
      'Skip to content',
    ]);
    expect(result.untranslated).toEqual([]);
  });

  it('refuses a key whose parent is a string', () => {
    expect(localeEdits([EN], [{ key: 'general.search.label', text: 'x' }])).toMatchObject({
      ok: false,
      error: { code: 'key-conflict', file: EN.path },
    });
    expect(
      localeEdits(
        [EN],
        [
          { key: 'x.y', text: 'a' },
          { key: 'x.y.z', text: 'b' },
        ],
      ),
    ).toMatchObject({ ok: false, error: { code: 'key-conflict' } });
  });

  it('refuses bad input files and bad entries', () => {
    expect(localeEdits([DE], [{ key: 'a.b', text: 'x' }])).toMatchObject({
      ok: false,
      error: { code: 'no-default-locale' },
    });
    expect(
      localeEdits(
        [EN, { path: 'locales/fr.default.json', source: '{}' }],
        [{ key: 'a.b', text: 'x' }],
      ),
    ).toMatchObject({ ok: false, error: { code: 'several-default-locales' } });
    expect(
      localeEdits([EN, { path: 'config/settings_data.json', source: '{}' }], []),
    ).toMatchObject({
      ok: false,
      error: { code: 'not-a-locale-file' },
    });
    expect(
      localeEdits([{ path: EN.path, source: '[1]' }], [{ key: 'a.b', text: 'x' }]),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-json' },
    });
    expect(
      localeEdits([{ path: EN.path, source: '{"a": 1,}' }], [{ key: 'a.b', text: 'x' }]),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-json' },
    });
    expect(localeEdits([EN], [{ key: 'bad', text: 'x' }])).toMatchObject({
      ok: false,
      error: { code: 'invalid-key' },
    });
    expect(localeEdits([EN], [{ key: 'a.b', text: '' }])).toMatchObject({
      ok: false,
      error: { code: 'invalid-text' },
    });
    expect(
      localeEdits([EN], [{ key: 'a.b', text: 'x', byLocale: { de: '{{ x }}' } }]),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-text' },
    });
  });

  it('adds keys to Dawn locale files without reformatting them, and skips keys Dawn has', () => {
    const files = ['locales/en.default.json', 'locales/de.json', 'locales/ja.json'].map((path) => ({
      path,
      source: readDawn(path),
    }));
    expect(
      localeEdits(files, [{ key: 'accessibility.skip_to_text', text: 'Skip to content' }]),
    ).toEqual({
      ok: true,
      edits: [],
      untranslated: [],
    });
    const result = localeEdits(files, [{ key: 'accessibility.rampsmith_cart', text: 'Cart' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toHaveLength(3);
    const out = apply(files, result.edits);
    for (const [index, file] of out.entries()) {
      const before = files[index]?.source ?? '';
      const parsed = JSON.parse(file.source) as { accessibility: Record<string, string> };
      expect(parsed.accessibility['rampsmith_cart']).toBe('Cart');
      // One line was added and the line before it gained a comma; every other line is unchanged.
      const beforeLines = before.split('\n');
      const afterLines = file.source.split('\n');
      expect(afterLines).toHaveLength(beforeLines.length + 1);
      const removed = beforeLines.filter((line) => !afterLines.includes(line));
      const added = afterLines.filter((line) => !beforeLines.includes(line));
      expect(removed).toHaveLength(1);
      expect(added).toEqual([`${removed[0] ?? ''},`, '    "rampsmith_cart": "Cart"']);
    }
  });
});

describe('localeEdits properties', () => {
  const segment = fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/u).filter((s) => !s.endsWith('_html'));
  const key = fc.array(segment, { minLength: 2, maxLength: 4 }).map((s) => s.join('.'));
  const text = fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((t) => translationTextProblem(t) === null);

  it('adds every requested key, keeps every existing value, and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(key, text), { maxLength: 5, selector: ([k]) => k }),
        (pairs) => {
          const entries = pairs.map(([k, t]) => ({ key: k, text: t }));
          const result = localeEdits([EN, DE], entries);
          if (!result.ok) {
            // Only a prefix clash (a.b and a.b.c) or a clash with an existing string may refuse.
            expect(result.error.code).toBe('key-conflict');
            return;
          }
          const out = apply([EN, DE], result.edits);
          for (const [index, file] of out.entries()) {
            const before = JSON.parse([EN, DE][index]?.source ?? '') as Record<
              string,
              Record<string, string>
            >;
            const after = JSON.parse(file.source) as Record<string, unknown>;
            expect(after).toMatchObject(before);
            for (const entry of entries) {
              const value = entry.key
                .split('.')
                .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], after);
              expect(
                typeof value === 'string' || (typeof value === 'object' && value !== null),
              ).toBe(true);
            }
          }
          expect(localeEdits(out, entries)).toEqual({ ok: true, edits: [], untranslated: [] });
        },
      ),
    );
  });
});
