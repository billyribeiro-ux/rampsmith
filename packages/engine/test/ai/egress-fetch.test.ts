import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { JobFailure } from '@rampsmith/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkImageUrl, fetchImageViaEgress } from '../../src/ai/egress-fetch.ts';

const OPENSSL = 'openssl';
const SECRET = 'x'.repeat(48);
const SCAN = '0192a3b4-c5d6-7e8f-9012-3456789abcde';
let dir: string;
let cert: string;
let key: string;
let tls: TlsServer;
let tlsPort: number;
let imageResponse: { status: number; body: Buffer } = { status: 200, body: Buffer.from('IMG') };

interface Seen {
  authority: string;
  authorization: string;
}
const seen: Seen[] = [];
let proxyMode: 'tunnel' | 'refuse' | 'unavailable' = 'tunnel';
let proxyUrl = '';
let proxyClose: () => void = () => undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rs-egress-'));
  // A throw-away self-signed certificate for the test image host; it is never committed.
  execFileSync(
    OPENSSL,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=cdn.shopify.com',
      '-addext',
      'subjectAltName=DNS:cdn.shopify.com',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  key = readFileSync(join(dir, 'key.pem'), 'utf8');
  tls = createTlsServer({ key, cert }, (socket) => {
    socket.once('data', () => {
      const { status, body } = imageResponse;
      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 ${String(status)} X\r\ncontent-type: image/jpeg\r\ncontent-length: ${String(body.length)}\r\nconnection: close\r\n\r\n`,
          ),
          body,
        ]),
      );
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  tlsPort = (tls.address() as AddressInfo).port;

  const proxy = createHttpServer();
  proxy.on('connect', (req: IncomingMessage, client: Socket) => {
    seen.push({
      authority: req.url ?? '',
      authorization: req.headers['proxy-authorization'] ?? '',
    });
    if (proxyMode === 'refuse') {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    if (proxyMode === 'unavailable') {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = netConnect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;
  proxyClose = () => {
    proxy.close();
  };
});
afterAll(() => {
  proxyClose();
  tls.close();
  rmSync(dir, { recursive: true, force: true });
});

const options = () => ({
  proxyUrl,
  tokenSecret: SECRET,
  scanId: SCAN,
  maxBytes: 1024,
  ca: cert,
  timeoutMs: 3000,
});
const URL_OK = 'https://cdn.shopify.com/s/files/1/0001/products/a.jpg?v=1';

async function failureOf(run: Promise<unknown>) {
  const error: unknown = await run.catch((e: unknown) => e);
  if (!(error instanceof JobFailure)) throw new Error('expected a JobFailure');
  return error.failure;
}

describe('checkImageUrl', () => {
  it.each([
    ['http://cdn.shopify.com/a.jpg'],
    ['https://evil.example/a.jpg'],
    ['https://cdn.shopify.com.evil.example/a.jpg'],
    ['https://user:pw@cdn.shopify.com/a.jpg'],
    ['https://cdn.shopify.com:8443/a.jpg'],
    ['not a url'],
    ['https://127.0.0.1/a.jpg'],
  ])('refuses %s permanently', (url) => {
    let thrown: unknown;
    try {
      checkImageUrl(url);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JobFailure);
    expect((thrown as JobFailure).failure.kind).toBe('permanent');
  });
});

describe('fetchImageViaEgress (ADR-025, ADR-035)', () => {
  it('opens a tunnel with a scan token for the one image host, then fetches over TLS inside it', async () => {
    proxyMode = 'tunnel';
    imageResponse = { status: 200, body: Buffer.from('JPEGBYTES') };
    seen.length = 0;
    const bytes = await fetchImageViaEgress(URL_OK, options());
    expect(bytes.toString()).toBe('JPEGBYTES');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authority).toBe('cdn.shopify.com:443');
    const [scheme, credentials] = (seen[0]?.authorization ?? '').split(' ');
    expect(scheme).toBe('Basic');
    const [user, token] = Buffer.from(credentials ?? '', 'base64')
      .toString()
      .split(':');
    expect(user).toBe('rampsmith');
    const [body] = (token ?? '').split('.');
    const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as {
      scan: string;
      hosts: string[];
      budget: number;
    };
    expect(claims).toMatchObject({ scan: SCAN, hosts: ['cdn.shopify.com'], budget: 2 });
  });

  it('treats a refusal by egress as permanent and an outage as retryable', async () => {
    proxyMode = 'refuse';
    expect((await failureOf(fetchImageViaEgress(URL_OK, options()))).error.code).toBe(
      'egress_refused',
    );
    proxyMode = 'unavailable';
    const unavailable = await failureOf(fetchImageViaEgress(URL_OK, options()));
    expect([unavailable.kind, unavailable.error.code]).toEqual(['retryable', 'egress_unavailable']);
    const down = await failureOf(
      fetchImageViaEgress(URL_OK, { ...options(), proxyUrl: 'http://127.0.0.1:1' }),
    );
    expect([down.kind, down.error.code]).toEqual(['retryable', 'egress_unreachable']);
  });

  it('classifies the image host status: 404 permanent, 503 retryable', async () => {
    proxyMode = 'tunnel';
    imageResponse = { status: 404, body: Buffer.from('') };
    const missing = await failureOf(fetchImageViaEgress(URL_OK, options()));
    expect([missing.kind, missing.error.code]).toEqual(['permanent', 'image_fetch_failed']);
    imageResponse = { status: 503, body: Buffer.from('') };
    expect((await failureOf(fetchImageViaEgress(URL_OK, options()))).kind).toBe('retryable');
  });

  it('stops reading at the size limit', async () => {
    proxyMode = 'tunnel';
    imageResponse = { status: 200, body: Buffer.alloc(5000, 1) };
    const big = await failureOf(fetchImageViaEgress(URL_OK, options()));
    expect([big.kind, big.error.code]).toEqual(['permanent', 'image_too_large']);
  });

  it('does not trust a certificate that is not for the host', async () => {
    proxyMode = 'tunnel';
    imageResponse = { status: 200, body: Buffer.from('x') };
    const { proxyUrl, tokenSecret, scanId, maxBytes, timeoutMs } = options();
    const withoutCa = { proxyUrl, tokenSecret, scanId, maxBytes, timeoutMs };
    expect((await failureOf(fetchImageViaEgress(URL_OK, withoutCa))).kind).toBe('retryable');
  });
});
