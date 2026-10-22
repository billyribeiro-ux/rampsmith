import { describe, expect, it } from 'vitest';
import { planPages } from '../src/pipeline/planner.ts';
import { EMPTY_BATCH, type Batch, type Sampling } from '../src/pipeline/snapshot.ts';
import { PAGE_TYPES } from '../src/pipeline/vocab.ts';

const ORIGIN = 'https://shop.example';

function store(counts: {
  products?: number;
  collections?: number;
  pages?: number;
  articles?: number;
  suffixes?: readonly string[];
}): Batch {
  const suffixes = counts.suffixes ?? [''];
  const make = (n: number | undefined, prefix: string) =>
    Array.from({ length: n ?? 0 }, (_, i) => ({
      id: `gid://shopify/${prefix}/${String(1000 + i)}`,
      handle: `${prefix.toLowerCase()}-${String(i)}`,
      template: suffixes[i % suffixes.length] ?? '',
      title: `${prefix} ${String(i)}`,
    }));
  return {
    ...EMPTY_BATCH,
    products: make(counts.products, 'Product').map((p) => ({
      ...p,
      descriptionHtml: '',
      media: [],
    })),
    collections: make(counts.collections, 'Collection').map((c) => ({ ...c, descriptionHtml: '' })),
    pages: make(counts.pages, 'Page').map((p) => ({ ...p, body: '' })),
    articles: make(counts.articles, 'Article').map((a) => ({
      ...a,
      body: '',
      blogHandle: 'news',
    })),
  };
}

const STARTER: Sampling = { mode: 'per_template', samples: 3, everyVariant: false };
const desktop = (plan: ReturnType<typeof planPages>) =>
  plan.filter((p) => p.viewport === 'desktop');

describe('planPages', () => {
  const big = store({ products: 40, collections: 12, pages: 6, articles: 9 });

  it('visits all eight page types, Starter taking 3 samples of each resource type', () => {
    const plan = desktop(planPages({ origin: ORIGIN, batch: big, sampling: STARTER }));
    const count = (type: string) => plan.filter((p) => p.pageType === type).length;
    expect(Object.fromEntries(PAGE_TYPES.map((t) => [t, count(t)]))).toEqual({
      home: 1,
      product: 3,
      collection: 3,
      cart: 1,
      search: 1,
      login: 1,
      page: 3,
      article: 3,
    });
  });

  it('puts breadth first: every page type is seen before any second sample', () => {
    const plan = desktop(planPages({ origin: ORIGIN, batch: big, sampling: STARTER }));
    expect(plan.slice(0, 8).map((p) => p.pageType)).toEqual(
      expect.arrayContaining([...PAGE_TYPES]),
    );
    expect(plan[0]?.pageType).toBe('home');
    expect(plan.map((p) => p.seq)).toEqual(plan.map((_, i) => i));
  });

  it('is deterministic: the same store and sampling give the same plan', () => {
    const a = planPages({ origin: ORIGIN, batch: big, sampling: STARTER });
    const b = planPages({ origin: ORIGIN, batch: structuredClone(big), sampling: STARTER });
    expect(b).toEqual(a);
  });

  it('spreads samples over the resources instead of taking the first ones', () => {
    const plan = planPages({ origin: ORIGIN, batch: big, sampling: STARTER });
    const products = plan.filter((p) => p.pageType === 'product' && p.viewport === 'desktop');
    expect(products.map((p) => p.url)).toEqual([
      `${ORIGIN}/products/product-0`,
      `${ORIGIN}/products/product-13`,
      `${ORIGIN}/products/product-26`,
    ]);
  });

  it('scans Free as the home page and five more pages, one type at a time', () => {
    const plan = desktop(
      planPages({ origin: ORIGIN, batch: big, sampling: { mode: 'home_plus', pages: 5 } }),
    );
    expect(plan).toHaveLength(6);
    expect(plan[0]?.pageType).toBe('home');
    expect(new Set(plan.map((p) => p.pageType)).size).toBe(6);
  });

  it('takes 10 samples per template on Growth, and 25 per variant on Pro', () => {
    const variants = store({ products: 120, suffixes: ['', 'long', 'lookbook'] });
    const growth = planPages({
      origin: ORIGIN,
      batch: variants,
      sampling: { mode: 'per_template', samples: 10, everyVariant: false },
    });
    expect(growth.filter((p) => p.pageType === 'product' && p.viewport === 'desktop')).toHaveLength(
      10,
    );
    // The variants are taken in turn, so a 10-page sample shows all three.
    expect(
      new Set(
        growth
          .filter((p) => p.pageType === 'product' && p.viewport === 'desktop')
          .map((p) => p.template),
      ),
    ).toEqual(new Set(['', 'long', 'lookbook']));

    const pro = planPages({
      origin: ORIGIN,
      batch: variants,
      sampling: { mode: 'per_template', samples: 25, everyVariant: true },
    });
    const proProducts = pro.filter((p) => p.pageType === 'product' && p.viewport === 'desktop');
    expect(proProducts).toHaveLength(75);
  });

  it('gives a store with no resources the four pages every store has', () => {
    const plan = desktop(planPages({ origin: ORIGIN, batch: EMPTY_BATCH, sampling: STARTER }));
    expect(plan.map((p) => p.pageType).sort()).toEqual(['cart', 'home', 'login', 'search']);
    expect(plan.find((p) => p.pageType === 'search')?.url).toBe(`${ORIGIN}/search?q=a`);
  });

  it('searches for the first product word and encodes handles', () => {
    const batch: Batch = {
      ...EMPTY_BATCH,
      products: [
        {
          id: 'gid://shopify/Product/1',
          handle: 'été/x y',
          template: '',
          title: 'Linen Field Shirt',
          descriptionHtml: '',
          media: [],
        },
      ],
    };
    const urls = planPages({ origin: ORIGIN, batch, sampling: STARTER }).map((p) => p.url);
    expect(urls).toContain(`${ORIGIN}/search?q=Linen`);
    expect(urls).toContain(`${ORIGIN}/products/%C3%A9t%C3%A9%2Fx%20y`);
  });

  it('checks the states on the first sample of a type, deep checks on desktop only', () => {
    const plan = planPages({ origin: ORIGIN, batch: big, sampling: STARTER });
    const product = plan.filter((p) => p.pageType === 'product');
    const [first, second, third, ...rest] = product;
    expect(first?.states).toEqual([
      'default',
      'nav_open',
      'variant_changed',
      'cart_drawer',
      'modal',
    ]);
    expect(first?.deep).toBe(true);
    expect(second?.states).toEqual(['default']);
    expect(third?.deep).toBe(false);
    const mobile = rest.find((p) => p.viewport === 'mobile');
    expect(mobile?.states).toEqual(['default', 'nav_open']);
    expect(mobile?.deep).toBe(false);
    expect(plan.find((p) => p.pageType === 'home')?.states).toEqual([
      'default',
      'nav_open',
      'modal',
    ]);
    expect(plan.find((p) => p.pageType === 'collection')?.states).toEqual(['default']);
  });

  it('loads one mobile page per page type, and the same states never run twice', () => {
    const plan = planPages({ origin: ORIGIN, batch: big, sampling: STARTER });
    const mobile = plan.filter((p) => p.viewport === 'mobile');
    expect(mobile.map((p) => p.pageType).sort()).toEqual([...PAGE_TYPES].sort());
    for (const page of plan) expect(new Set(page.states).size).toBe(page.states.length);
  });
});
