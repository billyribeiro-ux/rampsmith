// Browser test harness: launches one Chromium and serves the local fixtures through request
// interception, so no request ever leaves the process (ADR-115).
//
// CI uses the Chromium bundled with the locked playwright-core (installed by
// `playwright-core install --with-deps --only-shell chromium`). Environments that cannot
// download it point CHROMIUM_EXECUTABLE_PATH at another build and may pass CHROMIUM_ARGS,
// a JSON array of extra switches; only this test launcher reads either variable.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright-core';

const ORIGIN = 'http://shop.fixture.test';
const FIXTURES = join(import.meta.dirname, 'fixtures');

function extraArgs(): string[] {
  const raw = process.env['CHROMIUM_ARGS'];
  if (raw === undefined || raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((a): a is string => typeof a === 'string')) {
    throw new Error('CHROMIUM_ARGS must be a JSON array of strings');
  }
  return parsed;
}

export async function launch(): Promise<Browser> {
  const executablePath = process.env['CHROMIUM_EXECUTABLE_PATH'];
  return chromium.launch({
    headless: true,
    args: extraArgs(),
    ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
  });
}

/** Every request the fixture site saw, for assertions about what a script did. */
interface Traffic {
  readonly served: { readonly method: string; readonly path: string; readonly body: string }[];
  readonly blocked: string[];
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** A 5-second mono 8 kHz tone as a WAV file, generated so no binary fixture is committed. */
function toneWav(seconds = 5): Buffer {
  const rate = 8_000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeUInt8(128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i);
  }
  return buffer;
}

async function serve(route: Route, request: Request, traffic: Traffic): Promise<void> {
  const url = new URL(request.url());
  if (url.origin !== ORIGIN) {
    traffic.blocked.push(request.url());
    await route.abort('blockedbyclient');
    return;
  }
  traffic.served.push({
    method: request.method(),
    path: url.pathname,
    body: request.postData() ?? '',
  });
  if (url.pathname === '/media/tone.wav') {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: toneWav() });
    return;
  }
  if (url.pathname === '/cart/add.js' || url.pathname === '/cart/add') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    return;
  }
  if (/^\/(?:checkouts?|cart\/checkout)(?:\/|$)/.test(url.pathname)) {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>checkout</p>' });
    return;
  }
  const relative = normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(FIXTURES, relative);
  if (!file.startsWith(FIXTURES)) {
    await route.fulfill({ status: 404, body: 'not found' });
    return;
  }
  try {
    const body = await readFile(file);
    await route.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
      body,
    });
  } catch {
    await route.fulfill({ status: 404, body: 'not found' });
  }
}

export interface FixturePage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly traffic: Traffic;
}

/** A fresh context at `viewport`, with the fixture site mounted at ORIGIN. */
export async function openFixture(
  browser: Browser,
  path: string,
  viewport = { width: 1280, height: 800 },
): Promise<FixturePage> {
  const context = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC' });
  const traffic: Traffic = { served: [], blocked: [] };
  await context.route('**/*', (route, request) => serve(route, request, traffic));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
  return { context, page, traffic };
}
