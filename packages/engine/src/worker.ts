/**
 * The `scan.page@2` job (PLAN §10, §11, ADR-070): load one page of a verified site through
 * egress at one viewport, check it in each planned state, record the findings, and enqueue the
 * scan's finalisation when it was the last piece of work.
 */
import { JobFailure } from '@rampsmith/queue';
import type postgres from 'postgres';
import type { Browser } from 'playwright';
import { signScanToken } from './egress-token.ts';
import { isLastAttempt, parsePayload, requireTenant, type JobHandler } from './jobs/payload.ts';
import { finalizeWhenComplete } from './pipeline/finalize-trigger.ts';
import { scanPage, type PageScan, type ScanOptions } from './scan-page.ts';
import { recordFailure, recordPage, withTenant, type PageMeta } from './store.ts';

/** Hosts a Shopify storefront loads besides itself. */
export const SHOPIFY_CDN_HOSTS = ['cdn.shopify.com', '.shopifycdn.com', '.shopifycdn.net'];

export interface EngineDeps {
  readonly sql: postgres.Sql;
  readonly browser: Browser;
  readonly egress: {
    readonly proxyUrl: string;
    readonly tokenSecret: string;
  };
  readonly userAgent: string;
  /** Connections one page load may open through egress. */
  readonly budget?: number;
  readonly scan?: (browser: Browser, options: ScanOptions) => Promise<PageScan>;
  /**
   * The storefront password of a protected store, for this scan only. The engine holds no key to
   * unseal the stored one (ADR-035, ADR-071), so production wiring supplies none and a protected
   * store is reported as blocked.
   */
  readonly storefrontPassword?: (tenantId: string, siteId: string) => Promise<string | undefined>;
  /**
   * Tests only: maps the planned `https://` URL to the one the browser loads, so a local HTTP
   * fixture site can stand in for a store. Production wiring leaves it unset.
   */
  readonly rewriteUrl?: (url: URL) => URL;
}

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

/** Hosts the site may be loaded from: its `base_url` and the shop's primary domain. */
async function allowedHosts(
  sql: postgres.Sql,
  tenantId: string,
  siteId: string,
  scanId: string,
): Promise<{ hosts: Set<string>; verified: boolean } | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const [site] = await tx<{ base_url: string; verified: boolean }[]>`
      select base_url, verified_at is not null as verified
        from sites where tenant_id = ${tenantId} and id = ${siteId}`;
    if (site === undefined) return undefined;
    const hosts = new Set([new URL(site.base_url).host]);
    const [shop] = await tx<{ domain: string | null }[]>`
      select payload ->> 'primary_domain' as domain from scan_inputs
       where tenant_id = ${tenantId} and scan_id = ${scanId} and kind = 'shop'
       order by seq desc limit 1`;
    if (shop?.domain !== null && shop?.domain !== undefined && shop.domain !== '') {
      hosts.add(shop.domain.toLowerCase());
    }
    return { hosts, verified: site.verified };
  });
}

/** Whether the planned page at `seq` is flagged for the custom browser checks. */
async function isDeep(
  sql: postgres.Sql,
  tenantId: string,
  scanId: string,
  seq: number,
): Promise<boolean> {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx<{ deep: boolean | null }[]>`
      select (plan -> 'pages' -> ${seq}::int ->> 'deep')::boolean as deep
        from scans where tenant_id = ${tenantId} and id = ${scanId}`;
    return row?.deep === true;
  });
}

/** Checks a planned URL against the site's hosts; permanent failures otherwise. */
export async function onSiteUrl(
  sql: postgres.Sql,
  tenantId: string,
  siteId: string,
  scanId: string,
  url: string,
): Promise<URL> {
  const site = await allowedHosts(sql, tenantId, siteId, scanId);
  if (site === undefined) throw permanent('site_not_found', 'no such site for this tenant');
  // PLAN §11: scans run only on verified sites.
  if (!site.verified) throw permanent('site_not_verified', 'the site is not verified');
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw permanent('url_invalid', 'the page URL does not parse');
  }
  if (!site.hosts.has(target.host) || !['https:', 'http:'].includes(target.protocol)) {
    throw permanent('url_off_site', 'the page is not on the site');
  }
  return target;
}

export interface PageRequest {
  readonly tenantId: string;
  readonly siteId: string;
  readonly scanId: string;
  readonly target: URL;
  readonly viewport: ScanOptions['viewport'];
  readonly states: ScanOptions['states'];
  readonly deep: boolean;
  readonly cropSelectors?: readonly string[];
}

/** Scans `target` through egress with a token for its host only (ADR-025). */
export async function scanThroughEgress(deps: EngineDeps, request: PageRequest): Promise<PageScan> {
  const scan = deps.scan ?? scanPage;
  const load = deps.rewriteUrl?.(request.target) ?? request.target;
  const token = signScanToken(deps.egress.tokenSecret, {
    v: 1,
    scan: request.scanId,
    hosts: [request.target.hostname, ...SHOPIFY_CDN_HOSTS],
    budget: deps.budget ?? 400,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const password = await deps.storefrontPassword?.(request.tenantId, request.siteId);
  return scan(deps.browser, {
    url: load.href,
    userAgent: deps.userAgent,
    proxy: { server: deps.egress.proxyUrl, token },
    ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
    ...(request.states === undefined ? {} : { states: request.states }),
    deep: request.deep,
    ...(request.cropSelectors === undefined ? {} : { cropSelectors: request.cropSelectors }),
    ...(password === undefined ? {} : { storefrontPassword: password }),
  });
}

/** The handler `runWorker` calls for each `scan.page` job. */
export function scanPageHandler(deps: EngineDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'scan.page@2');
    const tenantId = requireTenant(job);
    const target = await onSiteUrl(
      deps.sql,
      tenantId,
      payload.site_id,
      payload.scan_id,
      payload.url,
    );
    const deep = await isDeep(deps.sql, tenantId, payload.scan_id, payload.seq);
    const ctx = { tenantId, siteId: payload.site_id, scanId: payload.scan_id };
    const meta: PageMeta = { pageType: payload.page_type, viewport: payload.viewport };

    let result: PageScan;
    try {
      result = await scanThroughEgress(deps, {
        ...ctx,
        target,
        viewport: payload.viewport,
        states: payload.states,
        deep,
      });
    } catch (error) {
      if (isLastAttempt(job)) {
        // No retry follows: count the page as failed so the scan can still finish.
        const failed = await recordFailure(deps.sql, ctx, target.href, meta);
        await finalizeWhenComplete(deps.sql, ctx, failed.progress?.complete === true);
      }
      throw new JobFailure('retryable', {
        code: 'page_load_failed',
        message: error instanceof Error ? error.message.slice(0, 200) : 'page load failed',
      });
    }
    // Record the planned URL, not the rewritten one, so a rescan and the plan agree.
    const outcome = await recordPage(deps.sql, ctx, { ...result, url: target.href }, meta);
    await finalizeWhenComplete(deps.sql, ctx, outcome.progress?.complete === true);
  };
}
