/**
 * Language checks on model output (PLAN §13: alt text is written in the store's primary
 * language; the evaluation harness checks language on every candidate). Two cheap checks:
 * the language tag the model reports must match the requested one, and the text must be
 * written mostly in that language's script.
 */

const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export function isLanguageTag(value: string): boolean {
  return value.length <= 35 && TAG.test(value);
}

function primarySubtag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? '';
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

const SCRIPTS: Readonly<Record<string, RegExp>> = {
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  bg: /\p{Script=Cyrillic}/u,
  sr: /[\p{Script=Cyrillic}\p{Script=Latin}]/u,
  el: /\p{Script=Greek}/u,
  ar: /\p{Script=Arabic}/u,
  fa: /\p{Script=Arabic}/u,
  ur: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u,
  th: /\p{Script=Thai}/u,
  hi: /\p{Script=Devanagari}/u,
};

/**
 * Whether `text` is plausibly written in `locale`'s script. Locales not listed are Latin
 * script; product and brand names in other scripts are allowed as long as most letters fit.
 */
function scriptMatches(text: string, locale: string): boolean {
  const letters = [...graphemes.segment(text)]
    .map(({ segment }) => segment)
    .filter((c) => /^\p{L}/u.test(c));
  if (letters.length === 0) {
    return true;
  }
  const script = SCRIPTS[primarySubtag(locale)] ?? /\p{Script=Latin}/u;
  const matching = letters.filter((c) => script.test(c.slice(0, 2))).length;
  return matching / letters.length >= 0.6;
}

/** Both checks: the reported tag and the script. */
export function languageMatches(text: string, reported: string, requested: string): boolean {
  return primarySubtag(reported) === primarySubtag(requested) && scriptMatches(text, requested);
}
