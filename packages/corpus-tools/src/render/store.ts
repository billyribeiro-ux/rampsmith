// Fixture store data (corpus/fixtures/*.json) turned into the Liquid objects a theme reads:
// shop, products, collections, pages, blogs, menus, cart and search (ADR-202).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_ROOT } from '../paths.ts';

interface ImageFixture {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

interface MediaFixture extends ImageFixture {
  readonly id: number;
}

interface VariantFixture {
  readonly id: number;
  readonly title: string;
  readonly option1: string;
  readonly price: number;
  readonly available: boolean;
}

interface ProductFixture {
  readonly id: number;
  readonly handle: string;
  readonly title: string;
  readonly vendor: string;
  readonly type: string;
  readonly price: number;
  readonly compare_at_price: number | null;
  readonly available: boolean;
  readonly description: string;
  readonly media: readonly MediaFixture[];
  readonly options: readonly string[];
  readonly variants: readonly VariantFixture[];
}

interface MenuLinkFixture {
  readonly title: string;
  readonly url: string;
  readonly links: readonly MenuLinkFixture[];
}

interface ArticleFixture {
  readonly id: number;
  readonly handle: string;
  readonly title: string;
  readonly author: string;
  readonly published_at: string;
  readonly image?: string;
  readonly content: string;
}

export interface StoreFixture {
  readonly shop: {
    readonly name: string;
    readonly url: string;
    readonly domain: string;
    readonly currency: string;
    readonly money_format: string;
    readonly money_with_currency_format: string;
    readonly description: string;
  };
  readonly locale: { readonly iso_code: string; readonly primary: boolean; readonly name: string };
  readonly images: Readonly<Record<string, ImageFixture>>;
  readonly menus: Readonly<Record<string, readonly MenuLinkFixture[]>>;
  readonly products: readonly ProductFixture[];
  readonly collections: readonly {
    readonly id: number;
    readonly handle: string;
    readonly title: string;
    readonly description: string;
    readonly image?: string;
    readonly products: readonly string[];
  }[];
  readonly pages: readonly {
    readonly id: number;
    readonly handle: string;
    readonly title: string;
    readonly content: string;
  }[];
  readonly blogs: readonly {
    readonly id: number;
    readonly handle: string;
    readonly title: string;
    readonly articles: readonly ArticleFixture[];
  }[];
  readonly cart: {
    readonly items: readonly {
      readonly product: string;
      readonly variant: number;
      readonly quantity: number;
    }[];
    readonly note: string;
  };
  readonly search: { readonly terms: string; readonly results: readonly string[] };
}

export function loadStore(relativePath: string): StoreFixture {
  const value: unknown = JSON.parse(readFileSync(join(CORPUS_ROOT, relativePath), 'utf8'));
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  for (const key of ['shop', 'locale', 'images', 'menus', 'products', 'collections', 'pages']) {
    if (!(key in value)) throw new Error(`${relativePath} has no ${key}`);
  }
  return value as StoreFixture;
}

export type LiquidObject = Record<string, unknown>;

/** An image as Liquid sees it; `image_url` and `image_tag` read `src`, `alt`, `width`, `height`. */
function imageObject(image: ImageFixture): LiquidObject {
  return {
    src: image.src,
    alt: image.alt,
    width: image.width,
    height: image.height,
    aspect_ratio: Math.round((image.width / image.height) * 1000) / 1000,
    media_type: 'image',
  };
}

/** Every object a page can read, built once per store. */
export interface StoreObjects {
  readonly shop: LiquidObject;
  readonly locale: StoreFixture['locale'];
  readonly images: ReadonlyMap<string, LiquidObject>;
  readonly products: ReadonlyMap<string, LiquidObject>;
  readonly collections: ReadonlyMap<string, LiquidObject>;
  readonly pages: ReadonlyMap<string, LiquidObject>;
  readonly blogs: ReadonlyMap<string, LiquidObject>;
  readonly linklists: Readonly<Record<string, LiquidObject>>;
  readonly cart: LiquidObject;
  readonly search: LiquidObject;
  readonly routes: Readonly<Record<string, string>>;
}

const ROUTES: Readonly<Record<string, string>> = {
  root_url: '/',
  account_url: '/account',
  account_login_url: '/account/login',
  account_logout_url: '/account/logout',
  account_register_url: '/account/register',
  account_recover_url: '/account/login#recover',
  account_addresses_url: '/account/addresses',
  collections_url: '/collections',
  all_products_collection_url: '/collections/all',
  search_url: '/search',
  predictive_search_url: '/search/suggest',
  cart_url: '/cart',
  cart_add_url: '/cart/add',
  cart_change_url: '/cart/change',
  cart_clear_url: '/cart/clear',
  cart_update_url: '/cart/update',
};

function product(fx: ProductFixture): LiquidObject {
  const url = `/products/${fx.handle}`;
  const media = fx.media.map((m) => ({
    ...imageObject(m),
    id: m.id,
    preview_image: imageObject(m),
  }));
  const variants = fx.variants.map((v) => ({
    ...v,
    url: `${url}?variant=${String(v.id)}`,
    product_id: fx.id,
  }));
  const firstAvailable = variants.find((v) => v.available) ?? variants[0];
  return {
    id: fx.id,
    handle: fx.handle,
    title: fx.title,
    vendor: fx.vendor,
    type: fx.type,
    url,
    price: fx.price,
    price_min: fx.price,
    price_max: Math.max(...fx.variants.map((v) => v.price)),
    price_varies: new Set(fx.variants.map((v) => v.price)).size > 1,
    compare_at_price: fx.compare_at_price,
    available: fx.available,
    description: fx.description,
    content: fx.description,
    media,
    images: media,
    featured_media: media[0] ?? null,
    featured_image: media[0] ?? null,
    options: fx.options,
    options_with_values: fx.options.map((name, i) => ({
      name,
      position: i + 1,
      values: [...new Set(fx.variants.map((v) => v.option1))],
    })),
    variants,
    selected_or_first_available_variant: firstAvailable,
    has_only_default_variant: fx.variants.length === 1 && fx.variants[0]?.title === 'Default Title',
  };
}

function menuLink(fx: MenuLinkFixture): LiquidObject {
  return {
    title: fx.title,
    url: fx.url,
    links: fx.links.map(menuLink),
    active: false,
    current: false,
    child_active: false,
  };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture store: ${what} does not exist`);
  return value;
}

export function storeObjects(store: StoreFixture): StoreObjects {
  const images = new Map(Object.entries(store.images).map(([k, v]) => [k, imageObject(v)]));
  const products = new Map(store.products.map((p) => [p.handle, product(p)]));
  const collections = new Map(
    store.collections.map((c) => {
      const items = c.products.map((h) => must(products.get(h), `product ${h}`));
      return [
        c.handle,
        {
          id: c.id,
          handle: c.handle,
          title: c.title,
          url: `/collections/${c.handle}`,
          description: c.description,
          image: c.image === undefined ? null : must(images.get(c.image), `image ${c.image}`),
          products: items,
          products_count: items.length,
          all_products_count: items.length,
        },
      ];
    }),
  );
  const pages = new Map(store.pages.map((p) => [p.handle, { ...p, url: `/pages/${p.handle}` }]));
  const blogs = new Map(
    store.blogs.map((b) => {
      const url = `/blogs/${b.handle}`;
      const articles = b.articles.map((a) => ({
        ...a,
        url: `${url}/${a.handle}`,
        image: a.image === undefined ? null : must(images.get(a.image), `image ${a.image}`),
        excerpt: '',
      }));
      return [
        b.handle,
        {
          id: b.id,
          handle: b.handle,
          title: b.title,
          url,
          articles,
          articles_count: articles.length,
        },
      ];
    }),
  );
  const linklists = Object.fromEntries(
    Object.entries(store.menus).map(([handle, links]) => [
      handle,
      { handle, title: handle, links: links.map(menuLink), levels: 2 },
    ]),
  );
  const items = store.cart.items.map((item, i) => {
    const p = must(products.get(item.product), `product ${item.product}`);
    const variants = p['variants'] as readonly { id: number; price: number; title: string }[];
    const variant = must(
      variants.find((v) => v.id === item.variant),
      `variant ${String(item.variant)}`,
    );
    return {
      key: `${String(variant.id)}:corpus`,
      index: i,
      product: p,
      variant,
      title: `${String(p['title'])} - ${variant.title}`,
      quantity: item.quantity,
      url: `${String(p['url'])}?variant=${String(variant.id)}`,
      url_to_remove: `/cart/change?line=${String(i + 1)}&quantity=0`,
      final_price: variant.price,
      final_line_price: variant.price * item.quantity,
    };
  });
  const cart = {
    items,
    item_count: items.reduce((n, item) => n + item.quantity, 0),
    total_price: items.reduce((n, item) => n + item.final_line_price, 0),
    note: store.cart.note,
  };
  const results = store.search.results.map((h) => must(products.get(h), `product ${h}`));
  const search = {
    performed: true,
    terms: store.search.terms,
    results,
    results_count: results.length,
  };
  return {
    shop: { ...store.shop, locale: store.locale.iso_code },
    locale: store.locale,
    images,
    products,
    collections,
    pages,
    blogs,
    linklists,
    cart,
    search,
    routes: ROUTES,
  };
}
