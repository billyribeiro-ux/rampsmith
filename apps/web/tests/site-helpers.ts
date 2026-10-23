import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The site with the scanner not connected (Turnstile stand-in on). */
export const SITE = 'http://127.0.0.1:3995';
/** The site with the fixed sample result. */
export const SITE_FIXTURE = 'http://127.0.0.1:3994';
/** The site with the scanner running through the api (stood in by tests/mock-api.ts). */
export const SITE_API = 'http://127.0.0.1:3992';
export const MOCK_API = 'http://127.0.0.1:3998';
/** A server started without Turnstile keys: the scanner must stay closed. */
export const SITE_CLOSED = 'http://127.0.0.1:3993';
/** What the production proxy sends, so SvelteKit sees the real scheme (see playwright.config.ts). */
export const PROXY_HEADERS = { 'x-forwarded-proto': 'http' };
export const TURNSTILE_FAKE = 'http://127.0.0.1:3990';

export interface SitePage {
  readonly path: string;
  readonly heading: string;
  /** Draft documents are never indexed. */
  readonly draft: boolean;
}

export const PAGES: readonly SitePage[] = [
  { path: '/', heading: 'Accessibility fixed at the source', draft: false },
  { path: '/how-it-works', heading: 'How it works', draft: false },
  { path: '/pricing', heading: 'Pricing', draft: false },
  { path: '/scan', heading: 'Free accessibility scan', draft: false },
  { path: '/accessibility', heading: 'Accessibility statement for Rampsmith', draft: true },
  { path: '/privacy', heading: 'Rampsmith privacy policy', draft: true },
  { path: '/terms', heading: 'Rampsmith terms of service', draft: true },
  { path: '/dpa', heading: 'Rampsmith Data Processing Addendum', draft: true },
  { path: '/subprocessors', heading: 'Subprocessors', draft: true },
];

export const SCHEMES = ['light', 'dark'] as const;

/** Zero violations of the WCAG 2.2 A and AA rules, and no rule left unable to decide. */
export async function axe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    results.violations.flatMap((v) =>
      v.nodes.map(
        (node) =>
          `${v.id}: ${node.target.join(' ')} ${node.any.map((check) => check.message).join('; ')}`,
      ),
    ),
  ).toEqual([]);
}
