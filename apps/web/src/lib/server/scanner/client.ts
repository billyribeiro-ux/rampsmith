/**
 * The free scanner's seam to the engine (PLAN §16, ADR-260).
 *
 * `main` has no queue or api route for a public free scan yet: the engine scans verified sites
 * for tenants (`scan.page`), and nothing accepts an anonymous request. The web side therefore
 * codes to this interface. `notConnectedScanner` is what runs until the engine side exists; it
 * answers every request with a clear "not connected" state. `fixtureScanner` returns a fixed
 * result, for the end-to-end tests of the result page only.
 */

/** One kind of failure on the scanned pages, with up to three examples. */
interface FailureGroup {
  /** The rule's id, such as `color-contrast`. */
  readonly ruleId: string;
  /** What the failure is, in plain words. */
  readonly title: string;
  /** The WCAG 2.2 success criterion, such as `1.4.3`. */
  readonly criterion: string;
  /** How many elements failed across the scanned pages. */
  readonly count: number;
  /** At most three. */
  readonly examples: readonly {
    readonly page: string;
    readonly snippet: string;
  }[];
}

export interface FreeScanResult {
  readonly domain: string;
  /** ISO 8601. */
  readonly scannedAt: string;
  /** The home page and up to two linked pages (PLAN §16). */
  readonly pages: readonly string[];
  /** Automated checks that passed, and how many ran: "Passes N of M" (PLAN §3). */
  readonly checksPassed: number;
  readonly checksRun: number;
  readonly failures: readonly FailureGroup[];
  /** True for the end-to-end fixture; the page says so. */
  readonly isFixture: boolean;
}

interface FreeScanRequest {
  /** The home page to scan, from `parsePublicUrl`. */
  readonly origin: string;
  readonly domain: string;
}

type FreeScanOutcome =
  | { readonly state: 'not-connected' }
  | { readonly state: 'refused'; readonly reason: 'robots' | 'bot-challenge' | 'unreachable' }
  | { readonly state: 'complete'; readonly result: FreeScanResult };

export interface FreeScanner {
  scan(request: FreeScanRequest): Promise<FreeScanOutcome>;
}

/** Until the engine accepts anonymous scans, every request gets this answer. */
export const notConnectedScanner: FreeScanner = {
  scan: () => Promise.resolve({ state: 'not-connected' }),
};

/** A fixed result, so the result page can be tested without an engine. Never a real scan. */
export function fixtureScanner(now: () => Date = () => new Date()): FreeScanner {
  return {
    scan: ({ origin, domain }) =>
      Promise.resolve({
        state: 'complete',
        result: {
          domain,
          scannedAt: now().toISOString(),
          pages: [origin, `${origin}collections/all`, `${origin}pages/contact`],
          checksPassed: 41,
          checksRun: 47,
          isFixture: true,
          failures: [
            {
              ruleId: 'image-alt',
              title: 'Images without a text alternative',
              criterion: '1.1.1',
              count: 12,
              examples: [
                { page: origin, snippet: '<img src="/cdn/hero.jpg">' },
                { page: origin, snippet: '<img src="/cdn/banner-2.jpg">' },
                { page: `${origin}collections/all`, snippet: '<img src="/cdn/p-104.jpg">' },
              ],
            },
            {
              ruleId: 'color-contrast',
              title: 'Text with too little contrast',
              criterion: '1.4.3',
              count: 5,
              examples: [{ page: origin, snippet: '<p class="subtle">Free shipping over $50</p>' }],
            },
          ],
        },
      }),
  };
}
