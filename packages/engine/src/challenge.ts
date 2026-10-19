/**
 * Bot-challenge detection (PLAN §11): a challenged page is reported as blocked, never solved
 * or evaded. Calibrated by spike S-2 (docs/spikes/S-2-bot-challenges.md): most Shopify
 * storefronts load hCaptcha for their forms, and some embed Cloudflare Turnstile, whose widget
 * markup carries `cf-chl-` ids. So challenge markup counts only on a page that is nothing but
 * the challenge; the `cf-mitigated` header and Cloudflare's interstitial title count anywhere.
 */
export type Challenge = 'cloudflare' | 'captcha' | 'rate_limited';

export interface LoadedPage {
  readonly status: number;
  readonly title: string;
  readonly html: string;
  /** The URL the page ended on, after redirects. */
  readonly url: string;
  /** Response headers of the main document, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
}

const CLOUDFLARE_TITLES = ['just a moment', 'attention required! | cloudflare'];
const CLOUDFLARE_MARKUP = ['_cf_chl_opt', 'cf-chl-'];
const CAPTCHA_MARKUP = [
  '/recaptcha/',
  'h-captcha',
  'hcaptcha.com',
  'challenges.cloudflare.com/turnstile',
];
/** A storefront page links to products, collections and pages; an interstitial does not. */
const MIN_LINKS_OF_A_REAL_PAGE = 5;

function linkCount(html: string): number {
  return html.match(/<a\s[^>]*href=/gi)?.length ?? 0;
}

/** Whether the page has no content of its own: few links and no Shopify sections. */
function interstitial(html: string): boolean {
  return linkCount(html) < MIN_LINKS_OF_A_REAL_PAGE && !html.includes('shopify-section');
}

/** Why the page is a challenge rather than the store, or `undefined`. */
export function detectChallenge(page: LoadedPage): Challenge | undefined {
  const title = page.title.trim().toLowerCase();
  const html = page.html.toLowerCase();
  if (
    page.headers['cf-mitigated'] === 'challenge' ||
    CLOUDFLARE_TITLES.some((t) => title.startsWith(t)) ||
    (CLOUDFLARE_MARKUP.some((m) => html.includes(m)) && interstitial(html))
  ) {
    return 'cloudflare';
  }
  // Shopify's bot protection answers on /challenge.
  if (new URL(page.url).pathname.replace(/\/+$/, '') === '/challenge') return 'captcha';
  if (CAPTCHA_MARKUP.some((m) => html.includes(m)) && interstitial(html)) return 'captcha';
  if (page.status === 429) return 'rate_limited';
  return undefined;
}
