/**
 * Rampsmith's own words for each fix (ADR-296): the commit summary and the finding line of the
 * pull request. Both are fixed phrases per rule, never text from a page: the summary passes the
 * commit-message check of `crates/github` (letters, digits and a few marks only, at most 100
 * characters), and neither can carry an instruction, a mention or a link.
 */

export interface Wording {
  readonly summary: string;
  readonly finding: string;
  /** The WCAG 2.2 success criterion when the finding row does not name one. */
  readonly criterion: string;
}

const WORDING: Readonly<Record<string, Wording>> = {
  'html-has-lang': {
    summary: 'Set the page language',
    finding: 'The page has no language, so screen readers cannot pick the right voice',
    criterion: '3.1.1',
  },
  'html-lang-valid': {
    summary: 'Set a valid page language',
    finding: 'The page language is not a valid language code',
    criterion: '3.1.1',
  },
  'image-alt': {
    summary: 'Add alternative text to an image',
    finding: 'An image has no alternative text',
    criterion: '1.1.1',
  },
  label: {
    summary: 'Give a form field an accessible name',
    finding: 'A form field has no label',
    criterion: '4.1.2',
  },
  'select-name': {
    summary: 'Give a select field an accessible name',
    finding: 'A select field has no label',
    criterion: '4.1.2',
  },
  'link-name': {
    summary: 'Give a link an accessible name',
    finding: 'A link has no text a screen reader can read',
    criterion: '2.4.4',
  },
  'button-name': {
    summary: 'Give a button an accessible name',
    finding: 'A button has no text a screen reader can read',
    criterion: '4.1.2',
  },
  bypass: {
    summary: 'Add a skip link',
    finding: 'The page has no way to skip past the header to the main content',
    criterion: '2.4.1',
  },
  'color-contrast': {
    summary: 'Raise the contrast of text',
    finding: 'Text does not have enough contrast with its background',
    criterion: '1.4.3',
  },
};

/** The wording for a rule, or `null` for a rule the code channel does not fix. */
export function wordingOf(rule: string): Wording | null {
  return WORDING[rule] ?? null;
}

/**
 * The success criterion for a finding: the first well-formed one the finding row lists (the
 * scanner stores them as `1.1.1`), else the rule's own.
 */
export function criterionOf(rule: string, criteria: readonly string[]): string | null {
  const listed = criteria.find((c) => /^[1-4]\.[0-9]{1,2}\.[0-9]{1,2}$/u.test(c));
  return listed ?? wordingOf(rule)?.criterion ?? null;
}

/** Page types of the scanner and the JSON template each is rendered with. */
const TEMPLATES: Readonly<Record<string, string>> = {
  home: 'index',
  collection: 'collection',
  product: 'product',
  cart: 'cart',
  search: 'search',
  login: 'customers/login',
  page: 'page',
  article: 'article',
};

export function templateOf(pageType: string | null): string {
  return (pageType === null ? undefined : TEMPLATES[pageType]) ?? 'index';
}
