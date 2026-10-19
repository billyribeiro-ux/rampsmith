// Network layer of the interactive-state guards (ADR-116), installed once per browser context
// and kept for the context's life.
//
// Facts from playwright-core 1.64.1 (types/types.d.ts and its server code), which shape it:
// - a page route sees neither popups nor Service Worker requests, and a route handler sees only
//   the first URL of a redirect chain (https://playwright.dev/docs/api/class-page#page-route),
//   so the guard is a context route and fetches same-store requests itself with
//   `route.fetch({ maxRedirects: 0 })`, refusing a redirect whose Location leads into checkout
//   or off the store;
// - `route.fetch` sends the request from Playwright with the context's proxy, or else the
//   browser's launch proxy (`BrowserContextAPIRequestContext._defaultOptions`), so it goes
//   through the same egress proxy as the browser when the engine configures one;
// - `serviceWorkers: 'block'` makes Playwright replace `ServiceWorkerContainer.prototype.register`
//   in every document; `scanContextOptions()` sets it and the guard checks it, and any service
//   worker that appears anyway trips the guard;
// - Chromium runs with its popup blocker off, so every page in the context other than the
//   scanned ones is closed as soon as it opens, and its requests meet the same route.
import type { BrowserContext, Page, Request, Route } from 'playwright-core';
import { isCheckoutUrl, screenRequest } from './guards.ts';

export type GuardKind = 'checkout' | 'personal_data' | 'navigation';

/** One thing the guard stopped. `detail` names the origin and path, never the query. */
export interface GuardTrip {
  readonly guard: GuardKind;
  readonly detail: string;
}

export interface CheckoutGuard {
  /** Everything stopped since the guard was installed on the context, oldest first. */
  readonly trips: readonly GuardTrip[];
  /** Top-level navigations of the scanned pages seen so far, allowed or stopped. */
  readonly navigations: number;
  /** Resolves once no request is being screened, or after `timeoutMs`. */
  idle(timeoutMs: number): Promise<void>;
}

interface GuardState extends CheckoutGuard {
  readonly trips: GuardTrip[];
  readonly scanned: Set<Page>;
  readonly stores: Set<string>;
  inFlight: number;
  navigations: number;
}

/** Context options every scan context must use: Service Worker registration is blocked. */
export function scanContextOptions(): { serviceWorkers: 'block' } {
  return { serviceWorkers: 'block' };
}

/** Thrown when a page's context cannot be guarded. */
export class GuardSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardSetupError';
  }
}

const states = new WeakMap<BrowserContext, Promise<GuardState>>();

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

function where(url: string): string {
  const parsed = parse(url);
  return parsed === null ? 'unreadable URL' : `${parsed.origin}${parsed.pathname}`;
}

// Paths the theme serves as files; they are left to the egress proxy, not fetched here.
const STATIC_FILE =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|wav|mp3|mp4|webm|json)$/i;

const MAX_REDIRECTS = 10;

function isStaticFile(url: URL): boolean {
  return url.pathname.startsWith('/cdn/') || STATIC_FILE.test(url.pathname);
}

function frameOf(request: Request): ReturnType<Request['frame']> | null {
  try {
    return request.frame();
  } catch {
    return null; // Service Worker requests have no frame.
  }
}

async function handle(state: GuardState, route: Route, request: Request): Promise<void> {
  const url = request.url();
  const trip = async (guard: GuardKind, detail: string): Promise<void> => {
    state.trips.push({ guard, detail: `${detail}: ${where(url)}` });
    await route.abort('blockedbyclient');
  };
  const frame = frameOf(request);
  const topLevel =
    request.isNavigationRequest() &&
    frame !== null &&
    [...state.scanned].some((page) => page.mainFrame() === frame);
  if (topLevel) state.navigations += 1;
  const screening = screenRequest(request.method(), url, request.postData(), state.stores);
  if (screening.block) {
    await trip(screening.guard, screening.detail);
    return;
  }
  const parsed = parse(url);
  if (parsed === null) {
    await route.fallback();
    return;
  }
  if (topLevel && state.stores.size > 0 && !state.stores.has(parsed.origin)) {
    await trip('navigation', 'navigation off the store');
    return;
  }
  if (!state.stores.has(parsed.origin) || isStaticFile(parsed)) {
    await route.fallback();
    return;
  }
  // A same-store request may redirect into checkout. The guard follows the chain itself, one
  // hop at a time without automatic redirects, and hands the browser only the final response:
  // a redirect the browser followed on its own would never reach this route again (measured:
  // a fulfilled 302 to /hop was followed without the route seeing /hop).
  let response: Awaited<ReturnType<Route['fetch']>>;
  let current = url;
  try {
    response = await route.fetch({ maxRedirects: 0 });
    for (let hops = 0; ; hops += 1) {
      const status = response.status();
      if (status < 300 || status >= 400) break;
      const location = response.headers()['location'];
      if (location === undefined) break;
      const next = parse(location, current);
      if (next === null || isCheckoutUrl(next.href)) {
        await trip('checkout', 'redirect into checkout');
        return;
      }
      if (!state.stores.has(next.origin)) {
        await trip('navigation', 'redirect off the store');
        return;
      }
      if (hops >= MAX_REDIRECTS) {
        await trip('navigation', 'too many redirects');
        return;
      }
      // 307 and 308 repeat the method and body; every other redirect becomes a GET.
      const repeat = status === 307 || status === 308;
      current = next.href;
      response = await route.fetch({
        url: current,
        maxRedirects: 0,
        ...(repeat ? {} : { method: 'GET', postData: '' }),
      });
    }
  } catch {
    await route.abort('failed');
    return;
  }
  await route.fulfill({ response });
}

async function install(context: BrowserContext): Promise<GuardState> {
  const state: GuardState = {
    trips: [],
    scanned: new Set(),
    stores: new Set(),
    inFlight: 0,
    navigations: 0,
    idle: async (timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (state.inFlight > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
  if (context.serviceWorkers().length > 0) {
    state.trips.push({ guard: 'checkout', detail: 'service worker already running' });
  }
  context.on('serviceworker', (worker) => {
    state.trips.push({
      guard: 'checkout',
      detail: `service worker started: ${where(worker.url())}`,
    });
  });
  context.on('page', (page) => {
    if (state.scanned.has(page)) return;
    state.trips.push({ guard: 'navigation', detail: 'new window closed' });
    page.close().catch(() => undefined);
  });
  await context.route(
    () => true,
    async (route, request) => {
      state.inFlight += 1;
      try {
        await handle(state, route, request);
      } finally {
        state.inFlight -= 1;
      }
    },
  );
  return state;
}

/** Whether Service Worker registration is blocked in the page (or impossible there). */
async function serviceWorkersBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (typeof ServiceWorkerContainer === 'undefined' || !globalThis.isSecureContext) return true;
    const register: unknown = Reflect.get(ServiceWorkerContainer.prototype, 'register');
    return typeof register === 'function' && String(register).includes('blocked by Playwright');
  });
}

/**
 * Installs the guard on `page`'s context, once, marks `page` as the page being scanned, and
 * closes every other page in the context. Later calls return the same guard. Throws
 * GuardSetupError when the context lets pages register Service Workers: create scan contexts
 * with `scanContextOptions()`.
 */
export async function guardCheckout(page: Page): Promise<CheckoutGuard> {
  const context = page.context();
  let pending = states.get(context);
  if (pending === undefined) {
    pending = install(context);
    states.set(context, pending);
  }
  const state = await pending;
  state.scanned.add(page);
  const origin = parse(page.url());
  if (origin !== null && (origin.protocol === 'https:' || origin.protocol === 'http:')) {
    state.stores.add(origin.origin);
  }
  for (const other of context.pages()) {
    if (!state.scanned.has(other)) await other.close().catch(() => undefined);
  }
  if (!(await serviceWorkersBlocked(page))) {
    throw new GuardSetupError(
      'service workers are not blocked in this context; create it with scanContextOptions()',
    );
  }
  return state;
}
