// Network half of the checkout guard: once installed on a page, every request that would
// enter checkout is aborted for the rest of the page's life, so a theme script that jumps to
// checkout after a state script returns is stopped too. A page route takes precedence over
// context routes, and requests it does not match fall through to them untouched
// (https://playwright.dev/docs/api/class-page#page-route). A route sees only the first URL of
// a redirect chain, so a cart form posted with `checkout`, which redirects into checkout, is
// stopped at the post (ADR-116).
import type { Page, Request, Route } from 'playwright-core';
import { isCheckoutRequest, isCheckoutUrl } from './guards.ts';

export interface CheckoutGuard {
  /** Origin and path of every request stopped; never the query, which may carry tokens. */
  readonly blocked: readonly string[];
}

const guards = new WeakMap<Page, Promise<CheckoutGuard>>();

function mayBeCheckout(url: URL): boolean {
  return isCheckoutUrl(url.href) || /(?:^|\/)cart\/?$/i.test(url.pathname);
}

async function install(page: Page): Promise<CheckoutGuard> {
  const blocked: string[] = [];
  const handler = async (route: Route, request: Request): Promise<void> => {
    if (isCheckoutRequest(request.method(), request.url(), request.postData())) {
      const url = new URL(request.url());
      blocked.push(`${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  };
  await page.route(mayBeCheckout, handler);
  return { blocked };
}

/**
 * Installs the checkout guard on `page`, once; later calls return the same guard. The
 * interactive-state scripts call it before they act, and the engine may call it when it opens
 * a page so the guard covers the whole visit.
 */
export function guardCheckout(page: Page): Promise<CheckoutGuard> {
  let guard = guards.get(page);
  if (guard === undefined) {
    guard = install(page);
    guards.set(page, guard);
  }
  return guard;
}
