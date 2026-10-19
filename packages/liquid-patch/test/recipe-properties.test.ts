/**
 * Property tests over generated failing markup: every recipe's first run returns edits that
 * re-parse and touch nothing outside their spans, and its run on its own output returns
 * `already-fixed`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Recipe } from '../src/recipes/types.ts';
import { documentLanguage } from '../src/recipes/document-language.ts';
import { emptyButton } from '../src/recipes/empty-button.ts';
import { emptyLink } from '../src/recipes/empty-link.ts';
import { formLabel } from '../src/recipes/form-label.ts';
import { imageAlt } from '../src/recipes/image-alt.ts';
import { skipLink } from '../src/recipes/skip-link.ts';
import { fixTwice, run, startOf } from './helpers.ts';

const eol = fc.constantFrom('\n', '\r\n');
const indent = fc.constantFrom('', '  ', '    ', '\t');
const separator = fc.constantFrom(' ', '  ', '\n  ', '\n    ', '\n\t');
const extraAttribute = fc.constantFrom(
  'class="x y"',
  'data-a="{{ section.id }}"',
  '{{ block.shopify_attributes }}',
  'hidden',
  "data-q='single'",
  'data-n=1',
  '{% if a %}data-c="1"{% endif %}',
  '{% # theme-check-disable %}',
);
const attributes = fc
  .array(fc.tuple(separator, extraAttribute), { maxLength: 4 })
  .map((pairs) => pairs.map(([sep, attr]) => `${sep}${attr}`).join(''));
const sibling = fc.constantFrom('', '<p>x</p>', '{% comment %}c{% endcomment %}', '{{ x }}');
const iconContent = fc.constantFrom(
  '',
  "{{ 'icon-cart.svg' | inline_asset_content }}",
  "{% render 'icon-close' %}",
  '<svg viewBox="0 0 1 1"><path d="M0"/></svg>',
  '<span class="svg-wrapper">{{- \'icon.svg\' | inline_asset_content -}}</span>',
);

interface Case<P> {
  readonly recipe: Recipe<P>;
  readonly path: string;
  readonly source: string;
  readonly marker: string;
  readonly params: P;
}

function check<P>({ recipe, path, source, marker, params }: Case<P>): void {
  const start = startOf(source, marker);
  const first = run(recipe, path, source, start, params);
  expect(first.kind, `${JSON.stringify(first)}\n${source}`).toBe('edits');
  if (first.kind !== 'edits') return;
  const after = fixTwice(recipe, path, source, start, params);
  const from = Math.min(...first.edits.map((e) => e.start));
  const to = Math.max(...first.edits.map((e) => e.end));
  expect(after.startsWith(source.slice(0, from))).toBe(true);
  expect(after.endsWith(source.slice(to))).toBe(true);
}

const LABEL = { key: 'accessibility.label', text: 'Label' };

describe('recipes on generated markup', () => {
  it('document-language', () => {
    fc.assert(
      fc.property(attributes, eol, indent, (attrs, nl, ind) => {
        check({
          recipe: documentLanguage,
          path: 'layout/theme.liquid',
          source: `<!doctype html>${nl}<html${attrs}>${nl}${ind}<head></head>${nl}${ind}<body></body>${nl}</html>${nl}`,
          marker: '<html',
          params: {},
        });
      }),
    );
  });

  it('skip-link', () => {
    fc.assert(
      fc.property(
        attributes,
        eol,
        indent,
        fc.boolean(),
        sibling,
        (attrs, nl, ind, withId, before) => {
          const main = withId ? '<main id="MainContent" role="main">' : '<main>';
          const source = [
            '<!doctype html>',
            '<html>',
            `${ind}<head>`,
            `${ind}${ind}<title>x</title>`,
            `${ind}</head>`,
            `${ind}<body${attrs}>`,
            `${ind}${ind}${before}`,
            `${ind}${ind}${main}{{ content_for_layout }}</main>`,
            `${ind}</body>`,
            '</html>',
            '',
          ].join(nl);
          check({
            recipe: skipLink,
            path: 'layout/theme.liquid',
            source,
            marker: '<body',
            params: {},
          });
        },
      ),
    );
  });

  it('empty-link and empty-button', () => {
    fc.assert(
      fc.property(
        attributes,
        eol,
        indent,
        iconContent,
        fc.boolean(),
        sibling,
        (attrs, nl, ind, content, multiline, before) => {
          const body = multiline ? `${nl}${ind}  ${content}${nl}${ind}` : content;
          check({
            recipe: emptyLink,
            path: 'sections/header.liquid',
            source: `${before}${nl}${ind}<a href="/cart"${attrs}>${body}</a>${nl}`,
            marker: '<a href="/cart"',
            params: { label: LABEL },
          });
          check({
            recipe: emptyButton,
            path: 'snippets/drawer.liquid',
            source: `${before}${nl}${ind}<button type="button"${attrs}>${body}</button>${nl}`,
            marker: '<button type="button"',
            params: { label: LABEL },
          });
        },
      ),
    );
  });

  it('form-label', () => {
    fc.assert(
      fc.property(
        attributes,
        eol,
        indent,
        fc.constantFrom('input', 'select', 'textarea'),
        fc.boolean(),
        (attrs, nl, ind, tag, selfClosing) => {
          const control =
            tag === 'input'
              ? `<input type="email" name="contact[email]"${attrs}${selfClosing ? ' />' : '>'}`
              : `<${tag} name="body"${attrs}></${tag}>`;
          check({
            recipe: formLabel,
            path: 'sections/newsletter.liquid',
            source: `<form>${nl}${ind}${control}${nl}</form>${nl}`,
            marker: `<${tag} `,
            params: { label: LABEL },
          });
        },
      ),
    );
  });

  it('image-alt', () => {
    fc.assert(
      fc.property(
        attributes,
        eol,
        indent,
        fc.constantFrom(
          'section.settings.image',
          'product.featured_media',
          'block.settings.logo',
          'image.src',
        ),
        fc.boolean(),
        (attrs, nl, ind, object, decorative) => {
          check({
            recipe: imageAlt,
            path: 'sections/banner.liquid',
            source: `<div>${nl}${ind}<img src="{{ ${object} | image_url: width: 600 }}"${attrs}>${nl}</div>${nl}`,
            marker: '<img',
            params: decorative ? { decorative: { reason: 'ornament' } } : {},
          });
        },
      ),
    );
  });
});
