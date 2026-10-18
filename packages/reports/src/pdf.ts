// Prints a report document to a tagged PDF with a document outline through Chromium
// (PLAN §16: "PDFs render from HTML through Chromium's print with `tagged: true` and a
// document outline"). Merchant data is in the page, so the page is isolated (ADR-223):
// JavaScript is off; the document's content security policy refuses every fetch; the context
// is offline and aborts every request it sees; and if the page tried to load anything or
// navigated anywhere, the PDF is discarded and an error raised. The caller owns the browser:
// the engine's Playwright Chromium in production, never launched with flags that weaken web
// security (such as --disable-web-security or --allow-file-access-from-files).
import { ReportDocument } from './document.ts';

/** The part of Playwright's `Page` this module uses. A Playwright `Page` satisfies it. */
export interface PdfPage {
  on(event: 'request', listener: (request: { url(): string }) => void): unknown;
  setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>;
  emulateMedia(options: { media: 'print' }): Promise<void>;
  pdf(options: {
    format: 'A4' | 'Letter';
    printBackground: boolean;
    preferCSSPageSize: boolean;
    tagged: boolean;
    outline: boolean;
  }): Promise<Uint8Array>;
  url(): string;
  frames(): readonly unknown[];
}

/** The part of Playwright's `BrowserContext` this module uses. */
export interface PdfContext {
  route(
    url: string,
    handler: (route: { abort(errorCode?: string): Promise<void> }) => Promise<void>,
  ): Promise<unknown>;
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}

/** The part of Playwright's `Browser` this module uses. */
export interface PdfBrowser {
  newContext(options: {
    javaScriptEnabled: false;
    offline: true;
    serviceWorkers: 'block';
    acceptDownloads: false;
    bypassCSP: false;
    locale: string;
    timezoneId: 'UTC';
  }): Promise<PdfContext>;
}

export interface PdfOptions {
  /** Paper size; the document's own `@page` rule sets A4 unless `Letter` is asked for. */
  readonly format?: 'A4' | 'Letter';
  /** Longest the load and the print may each take, in milliseconds. */
  readonly timeoutMs?: number;
}

/** The page tried something a report never needs; the PDF was discarded. */
export class ReportRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRenderError';
  }
}

/** Rejects when `promise` has not settled within `ms`; the caller's `finally` closes the page. */
async function withTimeout<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ReportRenderError(`${step} took longer than ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Prints a document this package rendered. Anything else is refused. */
export async function renderPdf(
  document: ReportDocument,
  browser: PdfBrowser,
  options: PdfOptions = {},
): Promise<Uint8Array> {
  if (!(document instanceof ReportDocument)) {
    throw new TypeError('renderPdf prints only documents rendered by @rampsmith/reports');
  }
  return printIsolated(document.html, document.lang, browser, options);
}

/**
 * The isolated print itself. Exported for the tests that feed it hostile markup directly, to
 * prove the isolation holds even if escaping ever failed; production code calls `renderPdf`.
 */
export async function printIsolated(
  markup: string,
  lang: string,
  browser: PdfBrowser,
  options: PdfOptions = {},
): Promise<Uint8Array> {
  const timeout = options.timeoutMs ?? 30_000;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    bypassCSP: false,
    locale: lang,
    timezoneId: 'UTC',
  });
  try {
    let attempts = 0;
    await context.route('**/*', async (route) => {
      await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('request', () => {
      attempts += 1;
    });
    // Playwright's own timeout is off (0); one deadline covers the load, and one the print.
    await withTimeout(
      page.setContent(markup, { waitUntil: 'load', timeout: 0 }),
      timeout,
      'loading',
    );
    await page.emulateMedia({ media: 'print' });
    const pdf = await withTimeout(
      page.pdf({
        format: options.format ?? 'A4',
        printBackground: true,
        preferCSSPageSize: options.format === undefined,
        tagged: true,
        outline: true,
      }),
      timeout,
      'printing',
    );
    // Counts only: a URL the page tried could carry merchant data, so it is never reported.
    if (attempts > 0) {
      throw new ReportRenderError(
        `the document tried to load ${String(attempts)} resource(s); reports load nothing`,
      );
    }
    if (page.url() !== 'about:blank' || page.frames().length !== 1) {
      throw new ReportRenderError('the document navigated or opened a frame; reports do neither');
    }
    return pdf;
  } finally {
    await context.close();
  }
}
