// Every string the embed shows comes from its locale files, every key it uses exists, and
// no locale string is left unused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deployedFiles } from '../src/extension-files.ts';
import {
  PSEUDO_CLOSE,
  PSEUDO_OPEN,
  flatten,
  pseudoTranslator,
  readLocale,
} from '../src/locales.ts';
import { EXTENSION_DIR, SCHEMA_LOCALE, STOREFRONT_LOCALE } from '../src/paths.ts';
import { renderEmbed, type EmbedInput } from '../src/render.ts';

const storefront = flatten(readLocale(STOREFRONT_LOCALE));
const schemaStrings = flatten(readLocale(SCHEMA_LOCALE));
const liquid = deployedFiles()
  .filter((f) => f.ext === '.liquid')
  .map((f) => readFileSync(`${EXTENSION_DIR}/${f.path}`, 'utf8'))
  .join('\n');

const usedKeys = new Set([...liquid.matchAll(/'([a-z0-9_.]+)'\s*\|\s*t\b/gu)].map((m) => m[1]));
const schemaKeys = new Set([...liquid.matchAll(/"t:([a-z0-9_.]+)"/gu)].map((m) => m[1]));

describe('locale files', () => {
  it('ship English as the one default for the storefront and the theme editor', () => {
    const locales = deployedFiles()
      .filter((f) => f.dir === 'locales')
      .map((f) => f.path);
    expect(locales).toEqual(['locales/en.default.json', 'locales/en.default.schema.json']);
  });

  it('define every storefront key the Liquid uses, and nothing it does not', () => {
    expect([...usedKeys].sort()).toEqual([...storefront.keys()].sort());
  });

  it('define every theme-editor key the schema uses, and nothing it does not', () => {
    expect([...schemaKeys].sort()).toEqual([...schemaStrings.keys()].sort());
  });

  it('use no HTML in any string, so the default escaping of `t` is always right', () => {
    for (const [key, value] of [...storefront, ...schemaStrings]) {
      expect(key.endsWith('_html'), key).toBe(false);
      expect(value, key).not.toMatch(/[<>]/u);
    }
  });
});

/** Visible text of rendered HTML: tags, styles and scripts removed, entities decoded. */
function visibleText(html: string): string {
  return html
    .replaceAll(/<style>[\s\S]*?<\/style>/gu, '')
    .replaceAll(/<script\b[\s\S]*?<\/script>/gu, '')
    .replaceAll(/<div class="rs-a11y__hp">[\s\S]*?<\/div>/gu, '')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

const markers = new RegExp(`${PSEUDO_OPEN}[a-z0-9_.]+${PSEUDO_CLOSE}`, 'gu');

describe('a pseudo-locale render', () => {
  const pseudo: EmbedInput = { translate: pseudoTranslator(storefront) };
  const cases: Record<string, EmbedInput> = {
    'link and form': {
      ...pseudo,
      statementMetafield: '/pages/a',
      settings: { show_report_form: true },
    },
    'theme editor notice': { ...pseudo, designMode: true },
  };

  for (const [name, input] of Object.entries(cases)) {
    it(`shows no text that bypasses the locale files (${name})`, async () => {
      const html = await renderEmbed(input);
      expect(visibleText(html).replaceAll(markers, '').trim()).toBe('');
      for (const [, attribute, value] of html.matchAll(
        /\s(aria-label|data-msg-[a-z-]+|title|placeholder|alt)="([^"]*)"/gu,
      )) {
        expect(value?.replaceAll(markers, ''), attribute).toBe('');
      }
    });
  }
});
