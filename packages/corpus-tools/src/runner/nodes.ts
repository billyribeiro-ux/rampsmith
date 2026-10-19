// What the scanner found on each page of a theme, joined to golden findings (corpus/CONTRACT.md,
// "The integrated runner", step 1): every golden finding's result nodes, each with the rendered
// element described for the source mapper and the data axe-core's checks reported.
import type {
  FindingToMap,
  MapEvidence,
  RenderedElement,
  RenderedResource,
} from '@rampsmith/liquid-patch';
import type { PageResult } from '../browser/check.ts';
import type { ThemeEntry } from '../manifest.ts';
import type { PageSpec } from '../render/renderer.ts';
import type { StoreFixture } from '../render/store.ts';

export interface FindingNode {
  readonly page: PageSpec;
  readonly index: number;
  readonly element: RenderedElement;
  /** axe-core's check data for the node, by check id; empty for a custom rule. */
  readonly data: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result nodes of every golden finding of a theme, from the scans of all its pages. */
export function nodesByFinding(
  entry: ThemeEntry,
  results: readonly PageResult[],
): Map<string, FindingNode[]> {
  const byFinding = new Map<string, FindingNode[]>();
  for (const result of results) {
    const page = entry.pages.find((p) => p.id === result.page);
    if (page === undefined) continue;
    for (const occurrence of [...result.occurrences, ...result.customOccurrences]) {
      for (const index of occurrence.indices) {
        const element = result.elements[index];
        if (element === undefined) continue;
        const node = result.nodes.find(
          (n) =>
            n.rule === occurrence.rule && n.outcome === occurrence.outcome && n.index === index,
        );
        const list = byFinding.get(occurrence.finding) ?? [];
        if (!list.some((n) => n.page.id === page.id && n.index === index)) {
          list.push({ page, index, element, data: node?.data ?? {} });
        }
        byFinding.set(occurrence.finding, list);
      }
    }
  }
  return byFinding;
}

function numberAt(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' ? value : undefined;
}

function checkData(node: FindingNode, id: string): Record<string, unknown> | undefined {
  const value = node.data[id];
  return isRecord(value) ? value : undefined;
}

/** What the scan measured, in the form the mapper takes. */
function evidenceOf(node: FindingNode): MapEvidence {
  const contrast = checkData(node, 'color-contrast');
  const size = checkData(node, 'target-size');
  const foreground = contrast?.['fgColor'];
  const width = numberAt(size, 'width');
  const height = numberAt(size, 'height');
  return {
    ...(typeof foreground === 'string' ? { foreground } : {}),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

export interface ContrastMeasure {
  readonly background: string;
  readonly fontSizePx: number;
  readonly bold: boolean;
}

/** axe-core's measure for a `color-contrast` node: `bgColor`, `fontSize` "10.5pt (14px)", weight. */
export function contrastMeasure(node: FindingNode): ContrastMeasure | undefined {
  const data = checkData(node, 'color-contrast');
  const background = data?.['bgColor'];
  const size = data?.['fontSize'];
  const weight = data?.['fontWeight'];
  const px = typeof size === 'string' ? /\((\d*\.?\d+)px\)/u.exec(size)?.[1] : undefined;
  if (typeof background !== 'string' || px === undefined) return undefined;
  return {
    background,
    fontSizePx: Number(px),
    bold: weight === 'bold' || (typeof weight === 'number' && weight >= 700),
  };
}

/** The store resource a page shows, with the HTML of its rich-text fields. */
function resourceOf(store: StoreFixture, spec: PageSpec): RenderedResource | undefined {
  const resource = spec.resource;
  if (resource === undefined) return undefined;
  switch (resource.type) {
    case 'product': {
      const found = store.products.find((p) => p.handle === resource.handle);
      return found === undefined
        ? undefined
        : {
            type: 'product',
            gid: `gid://shopify/Product/${String(found.id)}`,
            fields: { descriptionHtml: found.description },
          };
    }
    case 'collection': {
      const found = store.collections.find((c) => c.handle === resource.handle);
      return found === undefined
        ? undefined
        : {
            type: 'collection',
            gid: `gid://shopify/Collection/${String(found.id)}`,
            fields: { descriptionHtml: found.description },
          };
    }
    case 'page': {
      const found = store.pages.find((p) => p.handle === resource.handle);
      return found === undefined
        ? undefined
        : {
            type: 'page',
            gid: `gid://shopify/Page/${String(found.id)}`,
            fields: { body: found.content },
          };
    }
    case 'article': {
      const [blogHandle, articleHandle] = resource.handle.split('/');
      const article = store.blogs
        .find((b) => b.handle === blogHandle)
        ?.articles.find((a) => a.handle === articleHandle);
      return article === undefined
        ? undefined
        : {
            type: 'article',
            gid: `gid://shopify/Article/${String(article.id)}`,
            fields: { body: article.content },
          };
    }
    case 'blog':
      return undefined;
  }
}

/** The mapper's input for one node of a golden finding. */
export function toFinding(rule: string, node: FindingNode, store: StoreFixture): FindingToMap {
  const resource = resourceOf(store, node.page);
  return {
    rule,
    template: node.page.template,
    element: node.element,
    evidence: evidenceOf(node),
    ...(resource === undefined ? {} : { resource }),
  };
}
