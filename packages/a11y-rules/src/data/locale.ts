// Link texts that say nothing about the destination, keyed by language. Only English ships in
// R1; the EU languages follow in R3 (PLAN §5). An unsupported language skips the rule and the
// audit reports it as not run, so coverage is never overstated (PLAN §11, coverage disclosure).

const VAGUE_LINK_TEXT: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'en',
    [
      'click',
      'click here',
      'click this',
      'click this link',
      'tap here',
      'press here',
      'here',
      'this',
      'this link',
      'this page',
      'link',
      'more',
      'read more',
      'learn more',
      'find out more',
      'see more',
      'view more',
      'more info',
      'more information',
      'more details',
      'details',
      'continue',
      'go',
    ],
  ],
]);

/** The primary language subtag of a BCP 47 tag or a Shopify locale such as `pt-BR`. */
function primaryLanguage(locale: string): string {
  return (locale.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '').trim();
}

/** Lower-cases, drops punctuation and symbols, and collapses whitespace. */
export function normalizeLinkText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The vague phrases for `locale`, normalised, or `null` when the language is not supported. */
export function vagueLinkPhrases(locale: string): ReadonlySet<string> | null {
  const list = VAGUE_LINK_TEXT.get(primaryLanguage(locale));
  return list === undefined ? null : new Set(list.map(normalizeLinkText));
}

/** Languages the vague-link rule supports. */
export function supportedLinkTextLanguages(): readonly string[] {
  return [...VAGUE_LINK_TEXT.keys()];
}
