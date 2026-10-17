// Network half of the checkout guard: while an interactive-state script runs, every request
// that would enter checkout is aborted. A page route takes precedence over context routes,
// and requests it does not match fall through to them untouched
// (https://playwright.dev/docs/api/class-page#page-route). A route sees only the first URL of
// a redirect chain, so a cart form posted with `checkout`, which redirects into checkout, is
// stopped at the post (ADR-116).
import type { Page, Request, Route } from 'playwright-core';
import { isCheckoutRequest, isCheckoutUrl } from './guards.ts';

export interface CheckoutBlock {
  /** Origin and path of every request stopped; never the query, which may carry tokens. */
  readonly blocked: readonly string[];
  dispose(): Promise<void>;
}

function mayBeCheckout(url: URL): boolean {
  return isCheckoutUrl(url.href) || /(?:^|\/)cart\/?$/i.test(url.pathname);
}

export async function blockCheckout(page: Page): Promise<CheckoutBlock> {
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
  return {
    blocked,
    dispose: async () => {
      await page.unroute(mayBeCheckout, handler);
    },
  };
}
