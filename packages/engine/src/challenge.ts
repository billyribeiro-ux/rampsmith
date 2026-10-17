/**
 * Bot-challenge detection (PLAN §11): a challenged page is reported as blocked, never solved
 * or evaded.
 */
export type Challenge = 'cloudflare' | 'captcha' | 'rate_limited';

export interface LoadedPage {
  readonly status: number;
  readonly title: string;
  readonly html: string;
}

const CLOUDFLARE_TITLES = ['just a moment', 'attention required! | cloudflare'];

/** Why the page is a challenge rather than the store, or `undefined`. */
export function detectChallenge(page: LoadedPage): Challenge | undefined {
  const title = page.title.trim().toLowerCase();
  const html = page.html.toLowerCase();
  if (CLOUDFLARE_TITLES.some((t) => title.startsWith(t)) || html.includes('cf-chl')) {
    return 'cloudflare';
  }
  if (
    html.includes('/recaptcha/') ||
    html.includes('h-captcha') ||
    html.includes('challenges.cloudflare.com/turnstile')
  ) {
    return 'captcha';
  }
  if (page.status === 429) return 'rate_limited';
  return undefined;
}
