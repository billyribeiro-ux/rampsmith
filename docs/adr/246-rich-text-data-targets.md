# ADR-246: Rich text the theme prints maps to store data

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`, `src/map/data.ts`)

## Context

An empty link or an image without alternative text inside `{{ article.content }}` or
`{{ product.description }}` is not theme source: the HTML is store data, and the theme only
prints it. ADR-205 finding 4 found one such golden finding (`aurora/article-image-alt`, a `data`
span) and asked the mapper to route Liquid output of rich-text fields to the resource and field.
The fix is made through the Admin API after the merchant approves, never by a theme patch.

## Decision

1. **Which outputs.** A source element whose direct Liquid output, with no filter, is one of
   these prints a rich-text field; the Admin API field names were read on shopify.dev for
   version 2026-10 on 19 October 2026:

   | Liquid | Resource | Admin API field | Type |
   | --- | --- | --- | --- |
   | `article.content` | `Article` | `body` | `HTML!` ("complete with HTML markup") |
   | `article.excerpt` | `Article` | `summary` | `HTML` ("can include HTML markup") |
   | `page.content` | `Page` | `body` | `HTML!` |
   | `product.description`, `product.content` | `Product` | `descriptionHtml` | `HTML!` |
   | `collection.description` | `Collection` | `descriptionHtml` | `HTML!` |

   Sources: https://shopify.dev/docs/api/admin-graphql/latest/objects/Article, `/Page`,
   `/Product`, `/Collection` (each page shows version 2026-10, "latest"); Liquid:
   https://shopify.dev/docs/api/liquid/objects/article ("The content of the article",
   "The excerpt of the article"), `/page`, `/product` (`description` returns the same value as
   `content`). The Liquid page does not name `excerpt`'s Admin field; `Article.summary` is the
   only summary-like field, and `excerpt_or_content` is not mapped because it may print either.
2. **How.** The scanner supplies the resource the page shows (`type`, global id, the HTML of its
   rich-text fields). The mapper finds, in the section's render closure, the element whose
   Liquid output is one of the table's, and which of the rendered ancestors it is. The elements
   between it and the failing element must agree, level by level, with the field's HTML; the
   field's HTML is parsed with the same parser, and the element is the **only** start tag in the
   field with the same tag and attributes under the same chain. The result is
   `{kind: 'data', resource, field, start, end}` with the offsets of that start tag in the
   field text, at 0.95, and `rendersFrom` names the container element in the theme.
3. **Refusals to guess.** No fitting start tag, or several: `needs_review` with no candidate.
   The page's resource has no such field: `unmapped`. A page with no resource given, or whose
   theme prints no rich text for that resource type, falls back to the element search of
   ADR-244.
4. **No write.** `planFix` never produces edits for a `data` span (ADR-248); the engine's data
   channel is the API's.

## Consequences

- The corpus's one rich-text finding is mapped to the golden data span and counted in the
  mapping score; it is reviewed, not scored, in the fix rate (its expected channel is the Admin
  API).
- Rich text produced through a filter (`| strip_html`, `| truncate`) is not mapped here: the
  rendered text is no longer the field's HTML.

## Rejected alternatives

- Treating the container element in the theme as the target: the theme is not where the
  merchant's content lives, and a theme patch would not change what the page prints.
- Matching by text alone: authors repeat sentences; the tag, attributes and ancestors within the
  field are the evidence the mapper can state.
