# ADR-103: Translation keys for recipe labels, and what each locale file receives

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-1 (`packages/liquid-patch`)

## Context

PLAN §12 says labels added by recipes use theme translation keys, "added to every locale
file", because a label hard-coded in English breaks a store's other languages. The plan does
not say which files count, how to add a key without reformatting the file, or what text a
non-English locale gets.

Shopify's documentation, read on 2026-10-17:

- [Locales](https://shopify.dev/docs/storefronts/themes/architecture/locales): storefront locale
  files have a `.json` extension and "control translations for storefront content"; schema
  locale files have a `.schema.json` extension and "control translations for theme editor
  settings". Exactly one default file, `*.default.json`, is required, and the same applies to
  schema locale files. Merchants edit storefront translations in the Shopify Language Editor.
- [Storefront locale files](https://shopify.dev/docs/storefronts/themes/architecture/locales/storefront-locale-files):
  files live in `locales/`, are named by IETF language tag (`fi.json`, `pt-BR.json`); keys are
  nested category, group and description objects referenced as `{{ 'a.b.c' | t }}` with single
  quotes; "Translated content is escaped by default", and a key ending in `_html` is not
  escaped. A regional locale such as `en-CA` can inherit keys from its base language file.
  A locale file holds at most 3,400 translations, not counting overrides of Shopify-provided
  keys. The page does not say what renders when a key is missing from a non-default locale.
- Theme Check (`@shopify/theme-check-common` 3.30.1) reports, at error severity,
  `TranslationKeyExists` (a `t` key missing from the default locale) and `MatchingTranslations`
  (a non-default locale missing keys of the default one). Verified by test in ADR-104's suite.

## Decision

1. **Which files.** Storefront locale files only: `locales/<tag>.json` and the one
   `locales/<tag>.default.json`. `locales/*.schema.json` is skipped; recipe labels are storefront
   text. Any other path is refused (`not-a-locale-file`), as are zero or several default files.
2. **Keys** are two or more dot-separated segments of `a-z`, `0-9` and `_`, never ending in
   `_html`, so the `t` filter keeps escaping the text; this is also why a translation can sit
   inside a double-quoted attribute. Texts are non-empty, contain no `{{`/`}}` (interpolation)
   and no control characters. Recipes reuse Dawn's key names where Dawn has one (for example
   `accessibility.skip_to_text`), so on Dawn-derived themes the key usually exists already.
3. **Edits.** For each file, the deepest existing object on the key's path is found with
   `jsonc-parser`'s offsets; the missing part is inserted after that object's last property as
   one span insertion (`,` plus the new properties), using that file's indentation unit, line
   ending (`\n` or `\r\n`), colon spacing and one-line or multi-line object style. Several keys
   under one object become one insertion (ADR-101 forbids two insertions at one offset). A key
   that already exists, with any value, is left alone, so running the edits again yields none.
   Nothing else in the file changes; a key whose parent is a string is refused (`key-conflict`).
4. **What each locale receives.** Every storefront locale file gets every key. A file receives,
   in order of preference: the caller's text for its exact tag (`byLocale['pt-BR']`), the
   caller's text for its base language (`byLocale.pt`), or the recipe's English text. Files of
   a language other than English that receive the English text are returned as `untranslated`,
   so the fix record can tell the merchant which labels to translate in the Language Editor.
   The same rule covers a non-English default locale.

Why the English text and not nothing or a machine translation: Shopify documents no fallback
for a key missing from a non-default locale, Theme Check treats the missing key as an error,
and an unreviewed machine translation can put a wrong label in front of a screen-reader user
with nobody noticing. An English label is a working accessible name that the merchant can
see, search for and translate; the `untranslated` list makes the gap explicit.

## Consequences

- Locale patches are small insertions that rebase cleanly over merchant edits.
- The 3,400-translation limit is not checked: overrides of Shopify keys do not count toward it,
  which cannot be told from the file alone. A recipe adds at most one key; the risk is noted.
- A later stream (AI or a translation memory) can fill `byLocale` without changing this code.

## Plan correction

Shopify has two kinds of locale file, and only storefront ones hold storefront text. In PLAN
§12, "Fix catalog, in build order", the "Missing form labels" row's Fix cell, replace
"Visually hidden `<label for>` using a theme translation key, added to every locale file" with:

```markdown
Visually hidden `<label for>` using a theme translation key, added to every storefront locale file (`locales/*.json`, not `*.schema.json`; ADR-103)
```

## Rejected alternatives

- Adding the key only to the default locale: fails `MatchingTranslations` and relies on
  undocumented fallback behaviour.
- Reprinting the JSON with `JSON.stringify` or `jsonc-parser`'s `modify` formatter: rewrites or
  re-indents more than the new key, against ADR-007.
- Hard-coding English text in the markup: the failure PLAN §12 warns about.
