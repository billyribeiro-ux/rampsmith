/**
 * Missing document language (WCAG 3.1.1): `lang="{{ request.locale.iso_code }}"` on `<html>`
 * in a layout file (PLAN §12). `request.locale` is the storefront's active language
 * (https://shopify.dev/docs/api/liquid/objects/request#request-locale), and `iso_code` its
 * ISO code (https://shopify.dev/docs/api/liquid/objects/shop_locale#shop_locale-iso_code).
 */
import {
  attribute,
  findAttribute,
  insertAttribute,
  rawValue,
  replaceAttribute,
  staticValue,
} from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { alreadyFixed, fixed, locate, refuse, type Recipe, type RecipeTarget } from './types.ts';

export const LANG_VALUE = '{{ request.locale.iso_code }}';

const LAYOUT_FILE = /^layout\/[^/]+\.liquid$/u;

/** `{{ request.locale.iso_code }}`, with any spacing and whitespace control, and nothing else. */
const LOCALE_OUTPUT = /^\{\{-?\s*request\.locale\.iso_code\s*-?\}\}$/u;

export const documentLanguage: Recipe<Record<string, never>> = {
  id: 'document-language',
  wcag: ['3.1.1'],
  run(file: ParsedFile, target: RecipeTarget) {
    if (!LAYOUT_FILE.test(file.path)) {
      return refuse(
        'wrong-file',
        `the document language is set in layout/*.liquid, not ${file.path}`,
      );
    }
    const located = locate(file, target, ['html']);
    if (!located.ok) return located.outcome;
    const { node } = located.element;
    const lang = findAttribute(node, 'lang');
    const wanted = attribute('lang', LANG_VALUE);
    if (lang === null) return fixed([insertAttribute(file, node, wanted)]);
    if (lang.conditional) return refuse('conditional-attribute', 'lang is set inside a Liquid tag');
    const text = staticValue(lang.attr);
    if (text !== null) {
      return text.trim() === ''
        ? fixed([replaceAttribute(file, lang.attr, wanted)])
        : alreadyFixed(`<html> already has lang="${text}"`);
    }
    if (LOCALE_OUTPUT.test(rawValue(file, lang.attr).trim())) {
      return alreadyFixed('<html> already prints the storefront locale in lang');
    }
    return refuse('liquid-in-attribute', 'lang already holds other Liquid output');
  },
};
