import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog, CatalogError, directionOf, resolveLocale } from '../src/i18n.ts';
import { BASE_LOCALE, SHIPPED_CATALOGS } from '../src/translator.ts';

const root = join(import.meta.dirname, '..');

function plural(variable: string, one: string, other: string): unknown[] {
  return [
    {
      declarations: [`input ${variable}`, `local p = ${variable}: plural`],
      selectors: ['p'],
      match: { 'p=one': one, 'p=*': other },
    },
  ];
}

function format(json: Record<string, unknown>, key: string, params = {}, tag = 'en'): string {
  return new Catalog('en', json)
    .formatParts(key, params, tag)
    .map((part) => part.text)
    .join('');
}

describe('Catalog formatting', () => {
  it('substitutes placeholders and formats numbers for the locale', () => {
    const json = { a: 'Passes {passed} of {total}' };
    expect(format(json, 'a', { passed: 1234, total: 5000 })).toBe('Passes 1,234 of 5,000');
    expect(format(json, 'a', { passed: 1234, total: 5000 }, 'de')).toBe('Passes 1.234 of 5.000');
  });

  it('marks which parts came from placeholders', () => {
    const parts = new Catalog('en', { a: 'Hi {name}!' }).formatParts('a', { name: 'Ada' }, 'en');
    expect(parts).toEqual([{ text: 'Hi ' }, { variable: 'name', text: 'Ada' }, { text: '!' }]);
  });

  it('honours escapes', () => {
    expect(format({ a: 'Use \\{name\\} and \\\\' }, 'a')).toBe('Use {name} and \\');
  });

  it('picks plural variants with Intl.PluralRules', () => {
    const json = { n: plural('count', 'one item', '{count} items') };
    expect(format(json, 'n', { count: 1 })).toBe('one item');
    expect(format(json, 'n', { count: 0 })).toBe('0 items');
    expect(format(json, 'n', { count: 2 })).toBe('2 items');
  });

  it('prefers an exact value over a plural category', () => {
    const json = {
      n: [
        {
          declarations: ['input count', 'local exact = count', 'local p = count: plural'],
          selectors: ['exact', 'p'],
          match: {
            'exact=*, p=*': '{count} fixes',
            'exact=0, p=*': 'No fixes',
            'exact=*, p=one': 'One fix',
          },
        },
      ],
    };
    expect(format(json, 'n', { count: 0 })).toBe('No fixes');
    expect(format(json, 'n', { count: 1 })).toBe('One fix');
    expect(format(json, 'n', { count: 7 })).toBe('7 fixes');
  });

  it('throws when a placeholder has no value', () => {
    expect(() => format({ a: 'Hi {name}' }, 'a')).toThrow(CatalogError);
    expect(() => format({ n: plural('count', 'a', 'b') }, 'n')).toThrow(/no value given/u);
  });

  it('throws for a plural selector given a string', () => {
    expect(() => format({ n: plural('count', 'a', 'b') }, 'n', { count: '1' })).toThrow(
      /must be a number/u,
    );
  });

  it.each([
    ['markup', { a: '{#b}bold{/b}' }],
    ['a function', { a: '{rate: number style=percent}' }],
    ['an unclosed brace', { a: 'Hi {name' }],
    ['a stray closing brace', { a: 'Hi }' }],
    ['a bad escape', { a: 'Hi \\n' }],
    ['a non-identifier id', { 'a.b': 'x' }],
    ['a number', { a: 3 }],
    ['two variant objects', { a: [{ match: { '*': 'x' } }, { match: {} }] }],
    [
      'no fallback variant',
      {
        a: [
          {
            declarations: ['input n', 'local p = n: plural'],
            selectors: ['p'],
            match: { 'p=one': 'x' },
          },
        ],
      },
    ],
    [
      'a local reading an undeclared input',
      {
        a: [{ declarations: ['local p = n: plural'], selectors: ['p'], match: { 'p=*': 'x' } }],
      },
    ],
    [
      'an unsupported declaration',
      {
        a: [
          {
            declarations: ['input n', 'local p = n: number'],
            selectors: ['p'],
            match: { 'p=*': 'x' },
          },
        ],
      },
    ],
    [
      'a variant key missing a selector',
      {
        a: [
          {
            declarations: ['input n', 'input m'],
            selectors: ['n', 'm'],
            match: { 'n=*': 'x' },
          },
        ],
      },
    ],
  ])('rejects %s when the catalog loads', (_name, json) => {
    expect(() => new Catalog('en', json)).toThrow(CatalogError);
  });
});

describe('resolveLocale and directionOf', () => {
  const available = new Set(['en', 'de']);

  it('uses the exact catalog, then the language, then the base', () => {
    expect(resolveLocale(undefined, available, 'en')).toEqual({ catalog: 'en', tag: 'en' });
    expect(resolveLocale('de', available, 'en')).toEqual({ catalog: 'de', tag: 'de' });
    expect(resolveLocale('en-GB', available, 'en')).toEqual({ catalog: 'en', tag: 'en-GB' });
    expect(resolveLocale('fr-CA', available, 'en')).toEqual({ catalog: 'en', tag: 'en' });
  });

  it('knows right-to-left languages', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('he-IL')).toBe('rtl');
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('en-GB')).toBe('ltr');
    expect(directionOf('de')).toBe('ltr');
  });
});

describe('the shipped catalogs', () => {
  const settings = JSON.parse(
    readFileSync(join(root, 'project.inlang', 'settings.json'), 'utf8'),
  ) as { baseLocale: string; locales: string[] };
  const files = readdirSync(join(root, 'messages'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();

  it('agree with project.inlang and the messages directory', () => {
    expect(settings.baseLocale).toBe(BASE_LOCALE);
    expect([...settings.locales].sort()).toEqual(files);
    expect(Object.keys(SHIPPED_CATALOGS).sort()).toEqual(files);
  });

  it('all compile', () => {
    for (const [locale, json] of Object.entries(SHIPPED_CATALOGS)) {
      expect(() => new Catalog(locale, json)).not.toThrow();
    }
  });

  it('use no variable a base message does not have', () => {
    const base = new Catalog(BASE_LOCALE, SHIPPED_CATALOGS[BASE_LOCALE] ?? {});
    for (const [locale, json] of Object.entries(SHIPPED_CATALOGS)) {
      const catalog = new Catalog(locale, json);
      for (const key of catalog.keys()) {
        expect(base.has(key), `${locale}: ${key} is not in the base catalog`).toBe(true);
        for (const variable of catalog.variables(key)) {
          expect(base.variables(key), `${locale}: ${key} uses {${variable}}`).toContain(variable);
        }
      }
    }
  });

  it('hold no message the code never uses', () => {
    const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(root, 'src', f), 'utf8'))
      .join('\n');
    const base = new Catalog(BASE_LOCALE, SHIPPED_CATALOGS[BASE_LOCALE] ?? {});
    const unused = base.keys().filter((key) => !sources.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
