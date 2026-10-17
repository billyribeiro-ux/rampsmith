/**
 * Missing alternative text on hard-coded theme images (WCAG 1.1.1): the image object's alt,
 * or `alt=""` with a recorded reason when the image is decorative (PLAN §12). The `image`
 * object's `alt` property holds the merchant's alt text
 * (https://shopify.dev/docs/api/liquid/objects/image#image-alt); `escape` keeps it safe inside
 * the attribute, as Dawn writes it (`alt="{{ collection.image.alt | escape }}"`).
 */
import { NodeTypes, type LiquidVariableOutput } from '@shopify/liquid-html-parser';
import {
  attribute,
  findAttribute,
  insertAttribute,
  staticValue,
  valueOutputs,
  type HtmlAttribute,
} from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { alreadyFixed, fixed, locate, refuse, type Recipe, type RecipeTarget } from './types.ts';

export interface ImageAltParams {
  /** Mark the image decorative: write `alt=""` and record why. */
  readonly decorative?: { readonly reason: string };
}

/**
 * Filters that turn an object into an image URL. `image_url` accepts article, collection,
 * image, line_item, product, variant and country objects and their `src` property
 * (https://shopify.dev/docs/api/liquid/filters/image_url); `img_url` is its older form.
 */
const IMAGE_URL_FILTERS: ReadonlySet<string> = new Set(['image_url', 'img_url']);
/**
 * Only image and media objects have an `alt` property, and Liquid types are not visible in
 * source, so the object must be named like one: `section.settings.image`, `product.images[0]`,
 * `card_product.featured_media`, `settings.logo`. `{{ product | image_url }}` is refused.
 */
const IMAGE_LIKE = /image|media|img|photo|picture|logo/iu;

/** True for `{{ some.lookup.alt ... }}`: output that prints an object's alt property. */
function printsAlt(node: LiquidVariableOutput): boolean {
  if (typeof node.markup === 'string') return false;
  const { expression } = node.markup;
  if (expression.type !== NodeTypes.VariableLookup) return false;
  const last = expression.lookups.at(-1);
  return last?.type === NodeTypes.String && last.value === 'alt';
}

/**
 * The source of the image object in `{{ object | image_url ... }}` (a trailing `.src` is
 * dropped), when the attribute has one named like an image or media object.
 */
function imageObject(file: ParsedFile, attr: HtmlAttribute): string | null {
  for (const output of valueOutputs(attr)) {
    if (typeof output.markup === 'string') continue;
    const { expression, filters } = output.markup;
    const [first] = filters;
    if (
      expression.type !== NodeTypes.VariableLookup ||
      first === undefined ||
      !IMAGE_URL_FILTERS.has(first.name)
    ) {
      continue;
    }
    let source = file.source.slice(expression.position.start, expression.position.end);
    let lookups = expression.lookups;
    const last = lookups.at(-1);
    if (last?.type === NodeTypes.String && last.value === 'src') {
      if (!source.endsWith('.src')) return null;
      source = source.slice(0, -'.src'.length);
      lookups = lookups.slice(0, -1);
    }
    const named = lookups.findLast((l) => l.type === NodeTypes.String);
    const name = named?.type === NodeTypes.String ? named.value : (expression.name ?? '');
    return IMAGE_LIKE.test(name) ? source : null;
  }
  return null;
}

export const imageAlt: Recipe<ImageAltParams> = {
  id: 'image-alt',
  wcag: ['1.1.1'],
  run(file: ParsedFile, target: RecipeTarget, params: ImageAltParams) {
    const reason = params.decorative?.reason;
    if (reason?.trim() === '')
      return refuse('invalid-parameter', 'a decorative image needs a reason');
    const located = locate(file, target, ['img']);
    if (!located.ok) return located.outcome;
    const { node } = located.element;

    const alt = findAttribute(node, 'alt');
    if (alt !== null) {
      if (alt.conditional) return refuse('conditional-attribute', 'alt is set inside a Liquid tag');
      if (staticValue(alt.attr) !== null)
        return alreadyFixed('the image already has an alt attribute');
      const outputs = valueOutputs(alt.attr);
      if (outputs.length > 0 && outputs.every(printsAlt)) {
        return alreadyFixed('the image already prints an alt property');
      }
      return refuse('liquid-in-attribute', 'alt already holds other Liquid output');
    }
    for (const name of ['role', 'aria-hidden']) {
      const found = findAttribute(node, name);
      const value = found === null || found.conditional ? null : staticValue(found.attr)?.trim();
      if (
        value === 'presentation' ||
        value === 'none' ||
        (name === 'aria-hidden' && value === 'true')
      ) {
        return alreadyFixed(`the image is hidden from assistive technology by ${name}="${value}"`);
      }
    }

    if (reason !== undefined) {
      return fixed(
        [insertAttribute(file, node, attribute('alt', ''))],
        [],
        [`decorative: ${reason.trim()}`],
      );
    }
    for (const name of ['src', 'srcset', 'data-src']) {
      const found = findAttribute(node, name);
      if (found === null || found.conditional) continue;
      const object = imageObject(file, found.attr);
      if (object !== null) {
        return fixed([
          insertAttribute(file, node, attribute('alt', `{{ ${object}.alt | escape }}`)),
        ]);
      }
    }
    return refuse(
      'no-image-object',
      'the image is not drawn from an image object; decide if it is decorative',
    );
  },
};
