/**
 * Rich text the theme prints (`{{ article.content }}`) is store data, not theme source
 * (ADR-205 finding 4, ADR-246): an element inside it maps to the resource and field, with the
 * offsets of its start tag in the field's HTML, as a data-audit finding reports it.
 *
 * Field names are the Admin API's: `Article.body`, `Article.summary`, `Page.body`,
 * `Product.descriptionHtml`, `Collection.descriptionHtml`.
 */
import { elements, isElement } from '../html.ts';
import { parseLiquid } from '../parse.ts';
import { attributesAgree, describeNode, sourceElements } from './elements.ts';
import type { ThemeIndex } from './theme.ts';
import type { DataSpan, ElementSpan, FindingToMap, MapOutcome, RenderedResource } from './types.ts';

const RICH_TEXT: Readonly<Record<string, { type: RenderedResource['type']; field: string }>> = {
  'article.content': { type: 'article', field: 'body' },
  'article.excerpt': { type: 'article', field: 'summary' },
  'page.content': { type: 'page', field: 'body' },
  'product.description': { type: 'product', field: 'descriptionHtml' },
  'collection.description': { type: 'collection', field: 'descriptionHtml' },
};

interface Container {
  readonly span: ElementSpan;
  readonly field: string;
  /** Index in the rendered ancestors of the element that holds the output. */
  readonly level: number;
}

function findContainer(
  index: ThemeIndex,
  files: readonly string[],
  finding: FindingToMap,
  resource: RenderedResource,
): Container | null {
  for (const path of files) {
    for (const source of sourceElements(index, path)) {
      if (source.info.tag === null) continue;
      for (const output of source.info.outputs) {
        const known = RICH_TEXT[output.path];
        if (known?.type !== resource.type || output.filters.length > 0) continue;
        const level = finding.element.ancestors.findIndex(
          (a) => attributesAgree(source.info, a, false).ok,
        );
        if (level === -1) continue;
        return {
          span: { kind: 'element', file: path, start: source.start, tag: source.info.tag },
          field: known.field,
          level,
        };
      }
    }
  }
  return null;
}

/**
 * Maps an element printed by a rich-text field. Returns `null` when no element of the theme
 * prints a field of the page's resource around it, so the caller searches theme source.
 */
export function mapRichText(
  index: ThemeIndex,
  files: readonly string[],
  finding: FindingToMap,
): MapOutcome | null {
  const { resource, element } = finding;
  if (resource === undefined) return null;
  const container = findContainer(index, files, finding, resource);
  if (container === null) return null;
  const html = resource.fields[container.field];
  if (html === undefined) {
    return { status: 'unmapped', reason: `the page's ${resource.type} has no ${container.field}` };
  }
  const parsed = parseLiquid(html);
  if (!parsed.ok) return { status: 'unmapped', reason: `${container.field} is not parseable HTML` };
  // The rendered elements between the container and the element, nearest first.
  const between = element.ancestors.slice(0, container.level);
  const matches = elements(parsed.ast).filter((located) => {
    if (!attributesAgree(describeNode(located.node), element, true).ok) return false;
    const above = located.ancestors.filter(isElement).reverse();
    return (
      above.length === between.length &&
      above.every((a, i) => {
        const rendered = between[i];
        return rendered !== undefined && attributesAgree(describeNode(a), rendered, false).ok;
      })
    );
  });
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    return {
      status: 'needs_review',
      reason:
        matches.length === 0
          ? `no <${element.tag}> of ${container.field} fits the rendered element`
          : `${String(matches.length)} elements of ${container.field} fit the rendered element`,
      candidates: [],
    };
  }
  const span: DataSpan = {
    kind: 'data',
    resource: resource.gid,
    field: container.field,
    start: only.node.blockStartPosition.start,
    end: only.node.blockStartPosition.end,
  };
  return {
    status: 'mapped',
    span,
    confidence: 0.95,
    why: [
      `${container.span.file} prints ${resource.type} rich text inside <${container.span.tag}> at offset ${String(container.span.start)}`,
      `the only <${element.tag}> of ${container.field} with these attributes is at ${String(span.start)}`,
    ],
    rendersFrom: container.span,
  };
}
