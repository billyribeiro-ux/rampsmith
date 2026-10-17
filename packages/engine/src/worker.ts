/**
 * The `scan.page` job (PLAN §10, §11): load one page of a verified site through egress, run
 * axe-core, record the findings.
 */
import type { ScanPage } from '@rampsmith/contracts-ts';
import { JobFailure } from '@rampsmith/queue';
import type postgres from 'postgres';
import type { Browser } from 'playwright';
import { signScanToken } from './egress-token.ts';
import { scanPage, type PageScan, type ScanOptions } from './scan-page.ts';
import { recordPage, withTenant } from './store.ts';

/** Hosts a Shopify storefront loads besides itself. */
export const SHOPIFY_CDN_HOSTS = ['cdn.shopify.com', '.shopifycdn.com', '.shopifycdn.net'];

export interface EngineDeps {
  readonly sql: postgres.Sql;
  readonly browser: Browser;
  readonly egress: {
    readonly proxyUrl: string;
    readonly tokenSecret: string;
    /** Tests only: route loopback through egress too. */
    readonly loopback?: boolean;
  };
  readonly userAgent: string;
  /** Connections one page load may open through egress. */
  readonly budget?: number;
  readonly scan?: (browser: Browser, options: ScanOptions) => Promise<PageScan>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

function parsePayload(schema: string, payload: unknown): ScanPage {
  if (schema !== 'scan.page@1') {
    throw permanent('payload_schema_unknown', `expected scan.page@1, got ${schema}`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw permanent('payload_invalid', 'payload is not an object');
  }
  const { scan_id: scanId, site_id: siteId, url, ...rest } = payload as Record<string, unknown>;
  if (
    typeof scanId !== 'string' ||
    !UUID.test(scanId) ||
    typeof siteId !== 'string' ||
    !UUID.test(siteId) ||
    typeof url !== 'string' ||
    Object.keys(rest).length > 0
  ) {
    throw permanent('payload_invalid', 'payload does not match scan.page@1');
  }
  return { scan_id: scanId, site_id: siteId, url };
}

/** The handler `runWorker` calls for each `scan.page` job. */
export function scanPageHandler(deps: EngineDeps) {
  const scan = deps.scan ?? scanPage;
  return async (job: {
    readonly payloadSchema: string;
    readonly payload: unknown;
    readonly tenantId: string | null;
  }): Promise<void> => {
    const payload = parsePayload(job.payloadSchema, job.payload);
    const tenantId = job.tenantId;
    if (tenantId === null) throw permanent('tenant_missing', 'scan.page needs a tenant');

    const sites = await withTenant(
      deps.sql,
      tenantId,
      (tx) =>
        tx<{ base_url: string; verified: boolean }[]>`
        select base_url, verified_at is not null as verified
          from sites where tenant_id = ${tenantId} and id = ${payload.site_id}`,
    );
    const site = sites[0];
    if (site === undefined) throw permanent('site_not_found', 'no such site for this tenant');
    // PLAN §11: scans run only on verified sites.
    if (!site.verified) throw permanent('site_not_verified', 'the site is not verified');
    const siteHost = new URL(site.base_url).host;
    let target: URL;
    try {
      target = new URL(payload.url);
    } catch {
      throw permanent('url_invalid', 'the page URL does not parse');
    }
    if (target.host !== siteHost || !['https:', 'http:'].includes(target.protocol)) {
      throw permanent('url_off_site', 'the page is not on the site');
    }

    const token = signScanToken(deps.egress.tokenSecret, {
      v: 1,
      scan: payload.scan_id,
      hosts: [target.hostname, ...SHOPIFY_CDN_HOSTS],
      budget: deps.budget ?? 300,
      exp: Math.floor(Date.now() / 1000) + 120,
    });
    let result: PageScan;
    try {
      result = await scan(deps.browser, {
        url: target.href,
        userAgent: deps.userAgent,
        proxy: {
          server: deps.egress.proxyUrl,
          token,
          ...(deps.egress.loopback === true ? { loopback: true } : {}),
        },
      });
    } catch (error) {
      throw new JobFailure('retryable', {
        code: 'page_load_failed',
        message: error instanceof Error ? error.message.slice(0, 200) : 'page load failed',
      });
    }
    await recordPage(
      deps.sql,
      { tenantId, siteId: payload.site_id, scanId: payload.scan_id },
      result,
    );
  };
}
