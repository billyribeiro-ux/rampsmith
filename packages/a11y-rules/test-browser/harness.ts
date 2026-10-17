// Browser test harness: one Chromium, and the fixtures served by a loopback HTTP server so the
// checkout guard's `route.fetch` reaches them as it reaches a store (ADR-115). Requests to any
// other origin are aborted and recorded; each test asserts there were none.
//
// CI uses the Chromium bundled with the locked playwright-core (installed by
// `playwright-core install --with-deps --only-shell chromium`). Environments that cannot
// download it point CHROMIUM_EXECUTABLE_PATH at another build and may pass CHROMIUM_ARGS,
// a JSON array of extra switches; only this test launcher reads either variable.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { scanContextOptions } from '../src/index.ts';

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

interface Served {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const log: Served[] = [];
let server: Server | null = null;
let origin = '';

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

const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
`;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function respond(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const url = new URL(req.url ?? '/', origin);
  log.push({ method: req.method ?? 'GET', path: url.pathname, body });
  const path = url.pathname;
  // Shopify answers a form post with a redirect; the `fixture` parameter makes it hostile.
  const fixture = url.searchParams.get('fixture');
  if (path === '/media/tone.wav') send(res, 200, 'audio/wav', toneWav());
  else if (path === '/sw.js') send(res, 200, 'text/javascript', SERVICE_WORKER);
  else if (path === '/cart/add.js') send(res, 200, 'application/json', '{"items":[]}');
  else if (path === '/cart/add' && fixture === 'to-checkout') {
    redirect(res, '/checkouts/cn/fixture-token');
  } else if (path === '/cart/add' && fixture === 'chain') redirect(res, '/hop');
  else if (path === '/cart/add') redirect(res, '/cart');
  else if (path === '/hop') redirect(res, '/checkouts/cn/fixture-token');
  else if (/^\/(?:checkouts?|cart\/checkout)(?:\/|$)/.test(path)) {
    send(res, 200, 'text/html', '<p>checkout</p>');
  } else if (path === '/cart') send(res, 200, 'text/html', '<!doctype html><title>Cart</title>');
  else if (req.method !== 'GET') send(res, 200, 'application/json', '{}');
  else await serveFile(res, path);
}

async function serveFile(res: ServerResponse, path: string): Promise<void> {
  const relative = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(FIXTURES, relative);
  if (!file.startsWith(FIXTURES)) {
    send(res, 404, 'text/plain', 'not found');
    return;
  }
  try {
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file));
  } catch {
    send(res, 404, 'text/plain', 'not found');
  }
}

/** Starts the loopback fixture server for this test file. */
export async function startFixtureServer(): Promise<void> {
  if (server !== null) return;
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      respond(req, res, Buffer.concat(chunks).toString('utf8')).catch(() => {
        send(res, 500, 'text/plain', 'error');
      });
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
  server = s;
}

export async function stopFixtureServer(): Promise<void> {
  const s = server;
  server = null;
  if (s !== null) {
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
}

export interface FixturePage {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Requests the fixture server received since this fixture opened. */
  served(): readonly Served[];
  /** Requests to any other origin, all aborted. */
  readonly blocked: string[];
  readonly origin: string;
}

export interface FixtureOptions {
  readonly viewport?: { width: number; height: number };
  /** Leave Service Workers allowed, to prove the guard refuses such a context. */
  readonly allowServiceWorkers?: boolean;
}

/** A fresh scan context with the fixture site at `path`. */
export async function openFixture(
  browser: Browser,
  path: string,
  options: FixtureOptions = {},
): Promise<FixturePage> {
  if (server === null) throw new Error('call startFixtureServer() in beforeAll');
  const context = await browser.newContext({
    ...(options.allowServiceWorkers === true ? {} : scanContextOptions()),
    viewport: options.viewport ?? { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const blocked: string[] = [];
  await context.route('**/*', async (route, request) => {
    if (new URL(request.url()).origin === origin) {
      await route.continue();
      return;
    }
    blocked.push(request.url());
    await route.abort('blockedbyclient');
  });
  const start = log.length;
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return { context, page, served: () => log.slice(start), blocked, origin };
}
