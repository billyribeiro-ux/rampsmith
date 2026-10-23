/**
 * The `free_scan.run@1` job (PLAN §16, ADR-267): an anonymous scan of one public website for the
 * marketing site's free scanner. It belongs to no tenant and touches no tenant row.
 *
 * It honours `robots.txt` for the Rampsmith user agent, loads the home page and up to two linked
 * pages at the desktop viewport in the default state, always through `egress` with a token that
 * names the site's own hosts, and keeps a short summary: checks passed of checks run, and
 * the failures by type with three examples each. Nothing else about the pages is kept. A bot
 * challenge, a closed store or a robots refusal ends the scan as "refused"; it is never solved
 * or worked around (ADR-027).
 */
import { JobFailure } from '@rampsmith/queue';
import type {
  FreeScanExample,
  FreeScanFailure,
  FreeScanResult,
  FreeScanRun,
} from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import { fetchTextViaEgress, type TextFetcher, type TextResponse } from './egress-text.ts';
import { PAGE_TOKEN_TTL_SECONDS, signScanToken } from './egress-token.ts';
import { isLastAttempt, parsePayload, type JobHandler } from './jobs/payload.ts';
import { robotsAllows } from './robots.ts';
import { scanPage, type Occurrence, type PageScan } from './scan-page.ts';
import { BOT_TOKEN } from './user-agent.ts';
import { SHOPIFY_CDN_HOSTS, type EngineDeps } from './worker.ts';

/** Pages a free scan checks: the home page and two linked pages (PLAN §16). */
const MAX_PAGES = 3;
const MAX_GROUPS = 20;
const MAX_EXAMPLES = 3;
const MAX_SNIPPET = 240;
/** Connections one page may open through egress. */
const PAGE_BUDGET = 200;
/** Navigation budget per page. */
const PAGE_TIMEOUT_MS = 20_000;
/** Overall deadline of one page scan, whatever the page does (audit M2). */
const PAGE_DEADLINE_MS = 45_000;
/** The whole job's budget: robots.txt and every page. A page is not started with less than
 * {@link MIN_PAGE_MS} of it left. */
export const FREE_SCAN_BUDGET_MS = 120_000;
const MIN_PAGE_MS = 10_000;

type Refusal = 'robots' | 'bot-challenge' | 'unreachable';

/** Why a page that loaded could not be checked, as the visitor is told. */
function refusalOf(blocked: NonNullable<PageScan['blocked']>): Refusal {
  return blocked === 'storefront_password' ? 'unreachable' : 'bot-challenge';
}

/** The hosts a free scan of `host` may reach: the site and its subdomains, and Shopify's CDN. */
export function hostsFor(host: string): string[] {
  const apex = host.startsWith('www.') ? host.slice(4) : host;
  return [apex, `www.${apex}`, `.${apex}`, ...SHOPIFY_CDN_HOSTS];
}

const ASSET = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|mp4|webm|mp3|css|js|json|xml|txt)$/i;
/** Paths a free scan never visits: they act on an account, a cart or a session. */
const SKIPPED_PATH =
  /^\/(?:cart|checkout|checkouts|account|login|logout|register|password|admin|challenge|search|orders|apps|a\/|wishlist|\.well-known)(?:\/|$)/i;

/** The first path segment, which tells a collection from a product from a page. */
function kindOf(url: URL): string {
  return url.pathname.split('/').find((segment) => segment !== '') ?? '';
}

/**
 * Up to two pages to scan besides the home page, from the links the home page carries: same
 * site, plain `GET` pages, no account, cart, search or asset paths, and as different in kind as
 * the links allow (a collection, a product, a page) before repeating a kind.
 */
export function chooseLinks(home: URL, links: readonly string[], wanted = MAX_PAGES - 1): URL[] {
  const apex = (host: string) => (host.startsWith('www.') ? host.slice(4) : host);
  const seen = new Set<string>([home.pathname]);
  const candidates: URL[] = [];
  for (const raw of links) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.username !== '' || url.password !== '' || url.port !== home.port) continue;
    if (apex(url.hostname.toLowerCase()) !== apex(home.hostname.toLowerCase())) continue;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || seen.has(path) || ASSET.test(path) || SKIPPED_PATH.test(path)) continue;
    seen.add(path);
    // One address per page: the query and fragment never decide what is a different page.
    candidates.push(new URL(`${home.protocol}//${home.host}${path}`));
  }
  const chosen: URL[] = [];
  const kinds = new Set<string>();
  for (const url of candidates) {
    if (chosen.length >= wanted) break;
    if (kinds.has(kindOf(url))) continue;
    kinds.add(kindOf(url));
    chosen.push(url);
  }
  for (const url of candidates) {
    if (chosen.length >= wanted) break;
    if (!chosen.includes(url)) chosen.push(url);
  }
  return chosen;
}

/** One scanned page's contribution to the result. */
export interface PageSummary {
  readonly url: string;
  readonly violations: readonly Occurrence[];
  readonly incomplete: readonly Occurrence[];
  readonly rulesRun: readonly string[];
}

/** Reduces a page scan to what the result needs from its default state. */
export function summarise(url: string, scan: PageScan): PageSummary | undefined {
  const state = scan.states.find((s) => s.state === 'default');
  if (state?.result !== 'opened') return undefined;
  return {
    url,
    violations: state.violations,
    incomplete: state.incomplete,
    rulesRun: state.rulesRun,
  };
}

function snippetOf(html: string): string {
  // Printable characters only, on one line, cut to the contract's length.
  const clean = html.replaceAll(/[\p{Cc}\s]+/gu, ' ').trim();
  // By code point, so that a cut never leaves half of a surrogate pair (jsonb refuses one).
  let out = '';
  let count = 0;
  for (const point of clean) {
    if (count === MAX_SNIPPET) break;
    out += point;
    count += 1;
  }
  return out;
}

/**
 * The visitor's result (PLAN §16): checks passed of checks run, counted over distinct rules (a
 * rule counts as failed if it failed on any page and passed only if it passed on every page it
 * ran on), and the failures by type, most numerous first, with up to three examples each.
 */
export function aggregate(
  domain: string,
  pages: readonly PageSummary[],
  scannedAt: Date,
): FreeScanResult {
  const run = new Set<string>();
  const failed = new Set<string>();
  const undecided = new Set<string>();
  const groups = new Map<
    string,
    { first: Occurrence; count: number; examples: FreeScanExample[] }
  >();
  for (const page of pages) {
    for (const id of page.rulesRun) run.add(id);
    for (const o of page.incomplete) undecided.add(o.ruleId);
    for (const o of page.violations) {
      failed.add(o.ruleId);
      const group = groups.get(o.ruleId) ?? { first: o, count: 0, examples: [] };
      group.count += 1;
      if (group.examples.length < MAX_EXAMPLES) {
        group.examples.push({ page: page.url, snippet: snippetOf(o.html) });
      }
      groups.set(o.ruleId, group);
    }
  }
  const passed = [...run].filter((id) => !failed.has(id) && !undecided.has(id)).length;
  const failures: FreeScanFailure[] = [...groups.entries()]
    .map(([ruleId, group]) => ({
      rule_id: ruleId,
      title: snippetOf(group.first.help),
      criterion: group.first.criteria[0] ?? 'WCAG',
      count: group.count,
      examples: group.examples,
    }))
    .sort((a, b) => b.count - a.count || a.rule_id.localeCompare(b.rule_id))
    .slice(0, MAX_GROUPS);
  return {
    domain,
    scanned_at: scannedAt.toISOString(),
    pages: pages.map((p) => p.url),
    checks_passed: passed,
    checks_run: run.size,
    failures,
  };
}

interface Row {
  readonly origin: string;
  readonly domain: string;
  readonly status: string;
}

/** What the scan did, before it is written to the row. */
type Outcome =
  | { readonly kind: 'complete'; readonly result: FreeScanResult }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

async function begin(sql: postgres.Sql, id: string): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`
    update free_scans
       set status = 'running', started_at = coalesce(started_at, now())
     where id = ${id} and status in ('queued', 'running') and expires_at > now()
     returning origin, domain, status`;
  return row;
}

async function finish(sql: postgres.Sql, id: string, outcome: Outcome | 'failed'): Promise<void> {
  if (outcome === 'failed') {
    await sql`
      update free_scans set status = 'failed', finished_at = now()
       where id = ${id} and status in ('queued', 'running')`;
  } else if (outcome.kind === 'refused') {
    await sql`
      update free_scans set status = 'refused', refusal = ${outcome.refusal}, finished_at = now()
       where id = ${id} and status in ('queued', 'running')`;
  } else {
    await sql`
      update free_scans
         set status = 'complete', result = ${sql.json(outcome.result as unknown as postgres.JSONValue)},
             finished_at = now()
       where id = ${id} and status in ('queued', 'running')`;
  }
}

export interface FreeScanDeps extends EngineDeps {
  /** Test seam: fetches `robots.txt`. Production uses egress. */
  readonly fetchText?: TextFetcher;
  /** Test seam: the job's overall budget. Default {@link FREE_SCAN_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Test seam: the clock for the budget, in milliseconds. */
  readonly clock?: () => number;
}

/**
 * Whether robots.txt lets the Rampsmith agent fetch `path` (RFC 9309 §2.3.1), or why not:
 * a server that could not be asked is "unreachable", one that is asking crawlers to stay away
 * (5xx, 429) or that disallows the path is "robots".
 */
export function robotsVerdict(
  response: TextResponse | undefined,
  path: string,
): 'allowed' | Refusal {
  if (response === undefined) return 'unreachable';
  return robotsAllows(response, BOT_TOKEN, path) ? 'allowed' : 'robots';
}

/** The handler `runWorker` calls for each `free_scan.run` job. */
export function freeScanHandler(deps: FreeScanDeps): JobHandler {
  const fetchText = deps.fetchText ?? fetchTextViaEgress;
  return async (job) => {
    const payload: FreeScanRun = parsePayload(job, 'free_scan.run@1');
    const id = payload.free_scan_id;
    const row = await begin(deps.sql, id);
    // Gone, expired, or already finished by an earlier attempt: nothing to do.
    if (row === undefined) return;

    try {
      const outcome = await run(deps, fetchText, id, row);
      await finish(deps.sql, id, outcome);
    } catch (error) {
      if (error instanceof JobFailure && error.failure.kind === 'permanent') {
        await finish(deps.sql, id, 'failed');
        throw error;
      }
      if (isLastAttempt(job)) {
        // Nothing more will try: the site could not be reached on any attempt.
        await finish(deps.sql, id, { kind: 'refused', refusal: 'unreachable' });
        return;
      }
      throw new JobFailure('retryable', {
        code: 'free_scan_failed',
        message: error instanceof Error ? error.message.slice(0, 200) : 'free scan failed',
      });
    }
  };
}

async function run(
  deps: FreeScanDeps,
  fetchText: TextFetcher,
  id: string,
  row: Row,
): Promise<Outcome> {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const remaining = (): number => (deps.budgetMs ?? FREE_SCAN_BUDGET_MS) - (clock() - startedAt);
  const home = new URL(row.origin);
  const hosts = hostsFor(home.hostname);
  const load = (url: URL): URL => deps.rewriteUrl?.(url) ?? url;
  const robots = await fetchText(load(new URL('/robots.txt', home)), {
    proxyUrl: deps.egress.proxyUrl,
    tokenSecret: deps.egress.tokenSecret,
    scanId: id,
    hosts,
    userAgent: deps.userAgent,
  });
  const verdict = (url: URL) => robotsVerdict(robots, `${url.pathname}${url.search}`);
  const homeVerdict = verdict(home);
  if (homeVerdict !== 'allowed') return { kind: 'refused', refusal: homeVerdict };

  const scan = deps.scan ?? scanPage;
  const scanOne = (url: URL, collectLinks: boolean): Promise<PageScan> => {
    const token = signScanToken(deps.egress.tokenSecret, {
      v: 1,
      scan: id,
      hosts,
      budget: deps.budget ?? PAGE_BUDGET,
      exp: Math.floor(Date.now() / 1000) + PAGE_TOKEN_TTL_SECONDS,
    });
    return scan(deps.browser, {
      url: load(url).href,
      userAgent: deps.userAgent,
      proxy: { server: deps.egress.proxyUrl, token },
      viewport: 'desktop',
      states: ['default'],
      deep: false,
      timeoutMs: PAGE_TIMEOUT_MS,
      // A page ends at its own deadline or when the job's budget does, whichever is first.
      deadlineMs: Math.max(1, Math.min(PAGE_DEADLINE_MS, remaining())),
      collectLinks,
    });
  };

  const homeScan = await scanOne(home, true);
  if (homeScan.blocked !== undefined) {
    return { kind: 'refused', refusal: refusalOf(homeScan.blocked) };
  }
  const homeSummary = summarise(home.href, homeScan);
  if (homeSummary === undefined) return { kind: 'refused', refusal: 'unreachable' };
  const summaries: PageSummary[] = [homeSummary];

  // The home page may have redirected to the site's other spelling (www or not): links are
  // resolved against where it ended up, and only kept when still on the site.
  let base = home;
  try {
    base = new URL(homeScan.finalUrl);
  } catch {
    // Keep the origin the visitor gave.
  }
  for (const target of chooseLinks(base, homeScan.links ?? [])) {
    if (verdict(target) !== 'allowed') continue;
    // Out of budget: the result covers the pages scanned so far and says which they are.
    if (remaining() < MIN_PAGE_MS) break;
    try {
      const page = await scanOne(target, false);
      if (page.blocked !== undefined) continue;
      const summary = summarise(target.href, page);
      if (summary !== undefined) summaries.push(summary);
    } catch {
      // A linked page that does not load is left out; the result says which pages it covers.
    }
  }
  return { kind: 'complete', result: aggregate(row.domain, summaries, new Date()) };
}
