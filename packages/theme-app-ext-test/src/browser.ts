// Browser harness: one Chromium per test file, the storefront fixture served through request
// interception, and a fake of the whole app proxy path (Shopify signs the query, the api
// verifies it and applies the barrier-report rules). No request leaves the process: anything
// not served here is aborted and recorded.
//
// Chromium comes from src/chromium.ts. The sandbox is off because these pages are local
// fixtures; the scanning engine keeps its sandbox (PLAN §18).
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AxeResults } from 'axe-core';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright-core';
import { appProxySignature, verifyAppProxyQuery } from './app-proxy-signature.ts';
import { extraArgs } from './chromium.ts';
import { parseBarrierReport, type BarrierReport } from './barrier-report.ts';
import { SHOP_ORIGIN, renderPage, type PageInput } from './fixture.ts';
import { EXTENSION_DIR } from './paths.ts';
import { ASSET_PATH, CDN_ORIGIN } from './render.ts';

export const PAGE_URL = `${SHOP_ORIGIN}/products/blue-shirt`;
const PROXY_PREFIX = '/apps/rampsmith';
const PROXY_SECRET = 'fixture-client-secret';
const SHOP = 'fixture-store.myshopify.com';

const AXE_SOURCE = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
/** WCAG 2.2 A and AA, plus axe's best practices (landmarks, headings, regions). */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

export async function launch(executablePath: string): Promise<Browser> {
  return chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', ...extraArgs()],
  });
}

type ProxyMode =
  'normal' | 'rate-limited' | 'server-error' | 'server-invalid' | 'html-error' | 'connection-reset';

interface ProxyHit {
  readonly method: string;
  readonly accept: string;
  readonly fields: URLSearchParams;
  readonly status: number;
}

interface ProxyState {
  mode: ProxyMode;
  /** Milliseconds the fake api waits before answering. */
  delayMs: number;
  /** Every request that reached the fake api. */
  readonly hits: ProxyHit[];
  /** Reports the fake api accepted and kept. */
  readonly stored: BarrierReport[];
}

export interface Fixture {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly proxy: ProxyState;
  /** Requests aborted because nothing here serves them. */
  readonly blocked: string[];
  /** Extension assets the page requested. */
  readonly assets: string[];
  close(): Promise<void>;
}

export interface OpenOptions extends PageInput {
  readonly javaScript?: boolean;
  /** Serve the page but refuse the extension's script, as when it fails to load. */
  readonly blockScript?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
}

interface ApiAnswer {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The api side of the contract (ADR-162), run on the request Shopify forwarded. */
function api(proxy: ProxyState, method: string, rawQuery: string, body: string): ApiAnswer {
  const verified = verifyAppProxyQuery(rawQuery, PROXY_SECRET, Math.floor(Date.now() / 1000));
  if (!verified.ok) return { status: 401, json: { status: 'unauthorized' } };
  if (method !== 'POST') return { status: 405, json: { status: 'method_not_allowed' } };
  switch (proxy.mode) {
    case 'rate-limited':
      return { status: 429, json: { status: 'rate_limited' }, headers: { 'retry-after': '600' } };
    case 'server-error':
      return { status: 500, json: { status: 'error' } };
    case 'server-invalid':
      return {
        status: 400,
        json: { status: 'invalid', errors: [{ field: 'email', code: 'invalid' }] },
      };
    case 'normal':
    case 'html-error':
    case 'connection-reset':
      break;
  }
  const parsed = parseBarrierReport(body);
  switch (parsed.kind) {
    case 'too-large':
      return { status: 413, json: { status: 'too_large' } };
    case 'invalid':
      return { status: 400, json: { status: 'invalid', errors: parsed.errors } };
    case 'discarded':
      return { status: 200, json: { status: 'received' } };
    case 'accepted':
      proxy.stored.push(parsed.report);
      return { status: 200, json: { status: 'received' } };
  }
}

/** Shopify's side: add and sign the proxy parameters, forward, relay the answer. */
async function appProxy(route: Route, request: Request, proxy: ProxyState): Promise<void> {
  const url = new URL(request.url());
  const query = new URLSearchParams(url.search);
  query.set('shop', SHOP);
  query.set('logged_in_customer_id', '');
  query.set('path_prefix', PROXY_PREFIX);
  query.set('timestamp', String(Math.floor(Date.now() / 1000)));
  query.set('signature', appProxySignature(query, PROXY_SECRET));
  const body = request.postData() ?? '';
  const accept = (await request.headerValue('accept')) ?? '';
  const answer = api(proxy, request.method(), query.toString(), body);
  proxy.hits.push({
    method: request.method(),
    accept,
    fields: new URLSearchParams(body),
    status: answer.status,
  });
  if (proxy.delayMs > 0) await sleep(proxy.delayMs);
  if (proxy.mode === 'connection-reset') {
    await route.abort('connectionreset');
    return;
  }
  if (proxy.mode === 'html-error') {
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<p>Bad gateway</p>' });
    return;
  }
  if (accept.includes('application/json')) {
    await route.fulfill({
      status: answer.status,
      contentType: 'application/json; charset=utf-8',
      headers: answer.headers ?? {},
      body: JSON.stringify(answer.json),
    });
    return;
  }
  // A plain form post: the api answers with application/liquid, which Shopify renders in the
  // theme's layout. The api's page text is the api's own (ADR-162), not the extension's.
  const sent = answer.json['status'] === 'received';
  await route.fulfill({
    status: answer.status,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report</title></head><body><main><h1>${sent ? 'Report sent' : 'Report not sent'}</h1></main></body></html>`,
  });
}

/** Opens the storefront fixture in a fresh context. */
export async function open(browser: Browser, options: OpenOptions = {}): Promise<Fixture> {
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScript ?? true,
    viewport: options.viewport ?? { width: 1280, height: 800 },
  });
  const proxy: ProxyState = { mode: 'normal', delayMs: 0, hits: [], stored: [] };
  const blocked: string[] = [];
  const assets: string[] = [];
  const html = await renderPage(options);
  await context.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === SHOP_ORIGIN && url.pathname === '/products/blue-shirt') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    } else if (url.origin === SHOP_ORIGIN && url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
      await appProxy(route, request, proxy);
    } else if (url.origin === CDN_ORIGIN && url.pathname.startsWith(ASSET_PATH)) {
      const name = decodeURIComponent(url.pathname.slice(ASSET_PATH.length));
      assets.push(name);
      if (options.blockScript === true || name.includes('/')) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: await readFile(join(EXTENSION_DIR, 'assets', name)),
      });
    } else {
      blocked.push(request.url());
      await route.abort('blockedbyclient');
    }
  });
  if (options.javaScript !== false) await context.addInitScript(observe);
  const page = await context.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  return { context, page, proxy, blocked, assets, close: () => context.close() };
}

interface Observed {
  readonly shifts: { readonly value: number; readonly hadRecentInput: boolean }[];
  readonly outside: string[];
}

/** Runs in the page before any other script: records layout shifts and outside mutations. */
function observe(): void {
  const state: Observed = { shifts: [], outside: [] };
  Object.defineProperty(window, '__rsObserved', { value: state });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      state.shifts.push({ value: shift.value, hadRecentInput: shift.hadRecentInput });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const element = node instanceof Element ? node : node.parentElement;
        if ((element?.closest('[data-rampsmith-a11y]') ?? null) === null) {
          state.outside.push(`${record.type} on ${element?.tagName ?? '#text'}`);
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
}

export async function observed(page: Page): Promise<Observed> {
  return page.evaluate(() => (window as unknown as { __rsObserved: Observed }).__rsObserved);
}

/** Cumulative layout shift as Core Web Vitals counts it: shifts without recent input. */
export async function layoutShift(page: Page): Promise<number> {
  const { shifts } = await observed(page);
  return shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0);
}

export interface Violation {
  readonly id: string;
  readonly impact: string | null;
  readonly targets: string[];
}

/** Runs axe-core (WCAG 2.2 A and AA, best practices) on the page, or on one part of it. */
export async function axe(page: Page, include?: string): Promise<Violation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ include, tags }) => {
      const engine = (
        window as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> };
        }
      ).axe;
      const result = await engine.run(include ?? document, {
        runOnly: { type: 'tag', values: tags },
        resultTypes: ['violations'],
      });
      return result.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        targets: v.nodes.map((n) => n.target.join(' ')),
      }));
    },
    { include, tags: AXE_TAGS },
  );
}

export interface AxSummary {
  readonly role: string;
  readonly name: string;
  readonly description: string;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly focusable: boolean;
}

/** The browser's own accessibility tree entry for the first element matching `selector`. */
export async function axNode(page: Page, selector: string): Promise<AxSummary> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const node = nodes[0];
    if (node === undefined) throw new Error(`no accessibility node for ${selector}`);
    const property = (name: string): unknown =>
      node.properties?.find((p) => p.name === name)?.value.value;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      role: text(node.role?.value),
      name: text(node.name?.value),
      description: text(node.description?.value),
      invalid: property('invalid') === 'true',
      required: property('required') === true,
      focusable: property('focusable') === true,
    };
  } finally {
    await cdp.detach();
  }
}
