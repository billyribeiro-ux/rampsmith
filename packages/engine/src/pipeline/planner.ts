/**
 * Chooses the pages of a render scan (PLAN §11, "Render audit", step 1; ADR-070). Pure: the same
 * store data and sampling always give the same plan, so a rescan visits the same pages and a
 * finding that disappears is a fix, not a different sample.
 */
import type { Batch, Routable, Sampling } from './snapshot.ts';
import { PAGE_TYPES, type PageState, type PageType, type Viewport } from './vocab.ts';

/** One `scan.page@2` job of the plan. */
export interface PlannedPage {
  /** Position in the plan from 0; the job's idempotency key. */
  readonly seq: number;
  readonly pageType: PageType;
  /** The template (`templateSuffix`; empty for the default) the page was sampled from. */
  readonly template: string;
  readonly url: string;
  readonly viewport: Viewport;
  readonly states: readonly PageState[];
  /** Run the custom browser checks of PLAN §11 step 6 on this page. */
  readonly deep: boolean;
}

export interface PlanInput {
  /** The store's public origin, such as `https://shop.example`. */
  readonly origin: string;
  readonly batch: Batch;
  readonly sampling: Sampling;
}

interface Candidate {
  readonly pageType: PageType;
  readonly template: string;
  readonly path: string;
  readonly sortKey: string;
}

const encode = encodeURIComponent;

function candidates(batch: Batch): Map<PageType, Candidate[]> {
  const byType = new Map<PageType, Candidate[]>();
  const add = (pageType: PageType, template: string, path: string, sortKey: string): void => {
    const list = byType.get(pageType) ?? [];
    list.push({ pageType, template, path, sortKey });
    byType.set(pageType, list);
  };
  const routed = (
    pageType: PageType,
    list: readonly Routable[],
    path: (item: Routable) => string,
  ): void => {
    for (const item of list) add(pageType, item.template, path(item), item.id);
  };
  add('home', '', '/', '');
  add('cart', '', '/cart', '');
  // A search with a real term shows results; the first product's first word is stable.
  const term = batch.products[0]?.title.split(/\s+/u)[0] ?? '';
  add('search', '', `/search?q=${encode(term === '' ? 'a' : term)}`, '');
  add('login', '', '/account/login', '');
  routed('product', batch.products, (p) => `/products/${encode(p.handle)}`);
  routed('collection', batch.collections, (c) => `/collections/${encode(c.handle)}`);
  routed('page', batch.pages, (p) => `/pages/${encode(p.handle)}`);
  for (const article of batch.articles) {
    add(
      'article',
      article.template,
      `/blogs/${encode(article.blogHandle)}/${encode(article.handle)}`,
      article.id,
    );
  }
  for (const list of byType.values()) {
    list.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.path.localeCompare(b.path));
  }
  return byType;
}

/** `n` items spread evenly over `list`, so a sample is not just the oldest products. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (n >= list.length) return [...list];
  if (n <= 0) return [];
  const picked: T[] = [];
  for (let i = 0; i < n; i += 1) {
    const item = list[Math.floor((i * list.length) / n)];
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

/** Up to `n` candidates of one page type, taking the variants in turn so each is seen. */
function perTemplate(list: readonly Candidate[], n: number): Candidate[] {
  const variants = new Map<string, Candidate[]>();
  for (const c of list) variants.set(c.template, [...(variants.get(c.template) ?? []), c]);
  const queues = [...variants.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, members]) => spread(members, n));
  const taken: Candidate[] = [];
  for (let round = 0; taken.length < n; round += 1) {
    let any = false;
    for (const queue of queues) {
      const next = queue[round];
      if (next !== undefined && taken.length < n) {
        taken.push(next);
        any = true;
      }
    }
    if (!any) break;
  }
  return taken;
}

function chosen(byType: Map<PageType, Candidate[]>, sampling: Sampling): Candidate[][] {
  if (sampling.mode === 'home_plus') {
    // Home, then one page of each other type in turn until the budget is spent.
    const home = byType.get('home') ?? [];
    const queues = PAGE_TYPES.filter((t) => t !== 'home').map((t) =>
      perTemplate(byType.get(t) ?? [], sampling.pages),
    );
    const rest: Candidate[] = [];
    for (let round = 0; rest.length < sampling.pages; round += 1) {
      let any = false;
      for (const queue of queues) {
        const next = queue[round];
        if (next !== undefined && rest.length < sampling.pages) {
          rest.push(next);
          any = true;
        }
      }
      if (!any) break;
    }
    return [home.slice(0, 1), ...rest.map((c) => [c])];
  }
  return PAGE_TYPES.map((type) => {
    const list = byType.get(type) ?? [];
    if (!sampling.everyVariant) return perTemplate(list, sampling.samples);
    const variants = new Map<string, Candidate[]>();
    for (const c of list) variants.set(c.template, [...(variants.get(c.template) ?? []), c]);
    return [...variants.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, members]) => spread(members, sampling.samples));
  });
}

/** The states checked on a page: all of those the page type can show, on its first sample. */
function statesFor(pageType: PageType, first: boolean, viewport: Viewport): PageState[] {
  if (!first) return ['default'];
  const states: PageState[] = ['default'];
  if (pageType === 'home' || pageType === 'product') states.push('nav_open');
  if (viewport === 'desktop') {
    if (pageType === 'product') states.push('variant_changed', 'cart_drawer');
    if (pageType === 'home' || pageType === 'product') states.push('modal');
  }
  return states;
}

/**
 * The plan: every sampled page at desktop width, then the first sample of each type again at
 * mobile width. The order puts breadth first: home, then the first sample of each type, then the
 * further samples, so a scan cut short has still seen every page type.
 */
export function planPages(input: PlanInput): PlannedPage[] {
  const byType = candidates(input.batch);
  const groups = chosen(byType, input.sampling);
  const firsts: Candidate[] = [];
  const seconds: Candidate[] = [];
  const seenType = new Set<PageType>();
  for (const group of groups) {
    for (const c of group) {
      if (!seenType.has(c.pageType)) {
        seenType.add(c.pageType);
        firsts.push(c);
      } else {
        seconds.push(c);
      }
    }
  }
  const ordered = [...firsts, ...seconds];
  const plan: PlannedPage[] = [];
  const add = (c: Candidate, viewport: Viewport, first: boolean): void => {
    plan.push({
      seq: plan.length,
      pageType: c.pageType,
      template: c.template,
      url: new URL(c.path, input.origin).href,
      viewport,
      states: statesFor(c.pageType, first, viewport),
      deep: viewport === 'desktop' && first,
    });
  };
  for (const c of ordered) add(c, 'desktop', firsts.includes(c));
  for (const c of firsts) add(c, 'mobile', true);
  return plan;
}
