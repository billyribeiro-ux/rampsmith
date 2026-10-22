/**
 * The store data `ctl` read into `scan_inputs` (ADR-035), parsed for the engine. `ctl` writes the
 * rows (lane A, `shopify.read_store@1`); the engine never calls Shopify. The parser accepts the
 * payload spellings of the Admin API (`descriptionHtml`) and the database's (`description_html`),
 * ignores what it does not know, and drops an item it cannot read instead of failing the batch,
 * because one malformed product must not stop the audit of the other 249 (ADR-070).
 */
import type { MenuItemInput } from '@rampsmith/a11y-rules';

export type InputKind =
  'shop' | 'products' | 'collections' | 'pages' | 'articles' | 'menus' | 'verify';

/** Kinds `audit.data` reads. */
export const AUDITED_KINDS = ['products', 'collections', 'pages', 'articles', 'menus'] as const;
export type AuditedKind = (typeof AUDITED_KINDS)[number];

export type Sampling =
  | { readonly mode: 'home_plus'; readonly pages: number }
  | { readonly mode: 'per_template'; readonly samples: number; readonly everyVariant: boolean };

/** Starter's sampling, used when the shop input names none (PLAN §20). */
const DEFAULT_SAMPLING: Sampling = { mode: 'per_template', samples: 3, everyVariant: false };

export interface ShopFacts {
  /** The store's public host, when it differs from the site's `base_url`. */
  readonly primaryDomain: string | undefined;
  readonly primaryLocale: string;
  readonly locales: readonly string[];
  readonly sampling: Sampling;
}

export interface Routable {
  readonly id: string;
  readonly handle: string;
  /** `templateSuffix`, or an empty string for the default template. */
  readonly template: string;
}

interface ProductMedia {
  readonly id: string;
  readonly alt: string | null;
  readonly url: string | null;
  readonly fileName: string | null;
}

interface ProductItem extends Routable {
  readonly title: string;
  readonly descriptionHtml: string;
  readonly media: readonly ProductMedia[];
}

interface CollectionItem extends Routable {
  readonly title: string;
  readonly descriptionHtml: string;
}

interface PageItem extends Routable {
  readonly title: string;
  readonly body: string;
}

interface ArticleItem extends Routable {
  readonly title: string;
  readonly body: string;
  readonly blogHandle: string;
}

interface MenuItem {
  readonly id: string;
  readonly handle: string;
  readonly items: readonly MenuItemInput[];
}

export interface Batch {
  readonly products: readonly ProductItem[];
  readonly collections: readonly CollectionItem[];
  readonly pages: readonly PageItem[];
  readonly articles: readonly ArticleItem[];
  readonly menus: readonly MenuItem[];
}

export const EMPTY_BATCH: Batch = {
  products: [],
  collections: [],
  pages: [],
  articles: [],
  menus: [],
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first of `names` that holds a value. */
function pick(source: Json, ...names: string[]): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function text(source: Json, ...names: string[]): string | undefined {
  const value = pick(source, ...names);
  return typeof value === 'string' ? value : undefined;
}

function items(payload: unknown): Json[] {
  const list = Array.isArray(payload)
    ? payload
    : isObject(payload)
      ? pick(payload, 'items', 'nodes')
      : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function routable(source: Json): Routable | undefined {
  const id = text(source, 'id', 'gid');
  const handle = text(source, 'handle');
  if (id === undefined || handle === undefined || handle === '') return undefined;
  return { id, handle, template: text(source, 'template_suffix', 'templateSuffix') ?? '' };
}

function media(source: Json): ProductMedia | undefined {
  const id = text(source, 'id', 'gid');
  if (id === undefined) return undefined;
  const alt = pick(source, 'alt');
  const url = text(source, 'url', 'src');
  return {
    id,
    alt: typeof alt === 'string' ? alt : null,
    url: url ?? null,
    fileName: text(source, 'file_name', 'fileName', 'filename') ?? null,
  };
}

function menuItem(source: Json, depth: number): MenuItemInput | undefined {
  const resource = text(source, 'id', 'gid', 'resource');
  if (resource === undefined) return undefined;
  const url = pick(source, 'url');
  const children = pick(source, 'items', 'children');
  return {
    resource,
    title: text(source, 'title', 'label') ?? '',
    url: typeof url === 'string' ? url : null,
    items:
      depth < 8 && Array.isArray(children)
        ? children
            .filter(isObject)
            .map((child) => menuItem(child, depth + 1))
            .filter((child): child is MenuItemInput => child !== undefined)
        : [],
  };
}

function maybe<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

/** Parses one batch (`products`, `collections`, `pages`, `articles` or `menus`). */
export function parseBatch(kind: AuditedKind, payload: unknown): Batch {
  const list = items(payload);
  switch (kind) {
    case 'products':
      return {
        ...EMPTY_BATCH,
        products: list.flatMap((p) => {
          const route = routable(p);
          if (route === undefined) return [];
          const rawMedia = pick(p, 'media');
          return [
            {
              ...route,
              title: text(p, 'title') ?? '',
              descriptionHtml: text(p, 'description_html', 'descriptionHtml') ?? '',
              media: (Array.isArray(rawMedia) ? rawMedia : items(rawMedia))
                .filter(isObject)
                .flatMap((m) => maybe(media(m))),
            },
          ];
        }),
      };
    case 'collections':
      return {
        ...EMPTY_BATCH,
        collections: list.flatMap((c) =>
          maybe(
            ((route) =>
              route === undefined
                ? undefined
                : {
                    ...route,
                    title: text(c, 'title') ?? '',
                    descriptionHtml: text(c, 'description_html', 'descriptionHtml') ?? '',
                  })(routable(c)),
          ),
        ),
      };
    case 'pages':
      return {
        ...EMPTY_BATCH,
        pages: list.flatMap((p) =>
          maybe(
            ((route) =>
              route === undefined
                ? undefined
                : { ...route, title: text(p, 'title') ?? '', body: text(p, 'body') ?? '' })(
              routable(p),
            ),
          ),
        ),
      };
    case 'articles':
      return {
        ...EMPTY_BATCH,
        articles: list.flatMap((a) => {
          const route = routable(a);
          const blog = isObject(a['blog']) ? text(a['blog'], 'handle') : undefined;
          const blogHandle = text(a, 'blog_handle', 'blogHandle') ?? blog;
          if (route === undefined || blogHandle === undefined || blogHandle === '') return [];
          return [
            {
              ...route,
              title: text(a, 'title') ?? '',
              body: text(a, 'body') ?? '',
              blogHandle,
            },
          ];
        }),
      };
    case 'menus':
      return {
        ...EMPTY_BATCH,
        menus: list.flatMap((m) => {
          const id = text(m, 'id', 'gid');
          if (id === undefined) return [];
          const raw = pick(m, 'items');
          return [
            {
              id,
              handle: text(m, 'handle') ?? '',
              items: (Array.isArray(raw) ? raw : [])
                .filter(isObject)
                .flatMap((i) => maybe(menuItem(i, 0))),
            },
          ];
        }),
      };
  }
}

/** Joins batches of several rows into one. */
export function mergeBatches(batches: readonly Batch[]): Batch {
  return {
    products: batches.flatMap((b) => b.products),
    collections: batches.flatMap((b) => b.collections),
    pages: batches.flatMap((b) => b.pages),
    articles: batches.flatMap((b) => b.articles),
    menus: batches.flatMap((b) => b.menus),
  };
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function samplingOf(shop: Json): Sampling {
  const raw = pick(shop, 'sampling');
  if (!isObject(raw)) return DEFAULT_SAMPLING;
  const mode = text(raw, 'mode');
  if (mode === 'home_plus') {
    return { mode, pages: positive(pick(raw, 'pages')) ?? 5 };
  }
  const samples = positive(pick(raw, 'samples'));
  if (mode === 'per_template' && samples !== undefined) {
    return {
      mode,
      samples,
      everyVariant: pick(raw, 'every_variant', 'everyVariant') === true,
    };
  }
  return DEFAULT_SAMPLING;
}

/** Parses the `shop` input; `fallbackLocale` is the site's `primary_locale`. */
export function parseShop(payload: unknown, fallbackLocale: string): ShopFacts {
  const shop = isObject(payload) ? payload : {};
  const locales = pick(shop, 'locales');
  const names = Array.isArray(locales)
    ? locales.flatMap((l) =>
        typeof l === 'string' ? [l] : isObject(l) ? maybe(text(l, 'locale')) : [],
      )
    : [];
  return {
    primaryDomain: text(shop, 'primary_domain', 'primaryDomain')?.toLowerCase(),
    primaryLocale: text(shop, 'primary_locale', 'primaryLocale') ?? names[0] ?? fallbackLocale,
    locales: names,
    sampling: samplingOf(shop),
  };
}
