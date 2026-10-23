import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchTextViaEgress } from '../src/egress-text.ts';

const SECRET = 'x'.repeat(48);
let dir: string;
let cert: string;
let tls: TlsServer;
let tlsPort: number;
let proxyUrl = '';
let proxyClose: () => void = () => undefined;
/** What the fake site answers, by path. */
let answers: Record<string, string> = {};
const authorities: string[] = [];
const absolute: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rs-egress-text-'));
  execFileSync(
    'openssl',
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
      '/CN=shop.com',
      '-addext',
      'subjectAltName=DNS:shop.com,DNS:www.shop.com,DNS:evil.example',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  tls = createTlsServer({ key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert }, (socket) => {
    socket.once('data', (chunk: Buffer) => {
      const path = /^GET (\S+) /.exec(chunk.toString('latin1'))?.[1] ?? '/';
      socket.end(
        answers[path] ?? 'HTTP/1.1 404 X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
      );
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  tlsPort = (tls.address() as AddressInfo).port;

  const proxy = createHttpServer((req, res) => {
    // Plain HTTP arrives as an absolute-form request.
    absolute.push(`${req.url ?? ''} ${req.headers['proxy-authorization'] ?? ''}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('plain robots');
  });
  proxy.on('connect', (req: IncomingMessage, client: Socket) => {
    authorities.push(req.url ?? '');
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

const reply = (status: string, headers: string, body: string) =>
  `HTTP/1.1 ${status}\r\n${headers}content-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`;

const options = (hosts: string[]) => ({
  proxyUrl,
  tokenSecret: SECRET,
  scanId: '0192a3b4-c5d6-7e8f-9012-3456789abcde',
  hosts,
  userAgent: 'RampsmithBot/test',
  ca: cert,
  timeoutMs: 3000,
});

describe('fetchTextViaEgress', () => {
  it('reads an https document through a tunnel with a token for the named hosts', async () => {
    answers = {
      '/robots.txt': reply('200 OK', 'content-type: text/plain\r\n', 'User-agent: *\nAllow: /'),
    };
    authorities.length = 0;
    const got = await fetchTextViaEgress(
      new URL('https://shop.com/robots.txt'),
      options(['shop.com']),
    );
    expect(got).toEqual({ status: 200, text: 'User-agent: *\nAllow: /' });
    expect(authorities).toEqual(['shop.com:443']);
  });

  it('reports a status without a body as it is, and follows a redirect to the site’s www spelling', async () => {
    answers = {
      '/old': reply('301 Moved', 'location: https://www.shop.com/robots.txt\r\n', ''),
    };
    // The second hop answers 404 from the same fake server.
    const got = await fetchTextViaEgress(
      new URL('https://shop.com/old'),
      options(['shop.com', 'www.shop.com']),
    );
    expect(got?.status).toBe(404);
  });

  it('does not follow a redirect to a host the token does not name', async () => {
    answers = {
      '/robots.txt': reply('302 Found', 'location: https://evil.example/robots.txt\r\n', ''),
    };
    authorities.length = 0;
    const got = await fetchTextViaEgress(
      new URL('https://shop.com/robots.txt'),
      options(['shop.com']),
    );
    expect(got).toBeUndefined();
    expect(authorities).toEqual(['shop.com:443']);
  });

  it('gives up on a redirect loop', async () => {
    answers = {
      '/robots.txt': reply('302 Found', 'location: https://shop.com/robots.txt\r\n', ''),
    };
    expect(
      await fetchTextViaEgress(new URL('https://shop.com/robots.txt'), options(['shop.com'])),
    ).toBeUndefined();
  });

  it('sends plain http as an absolute-form request with the token as the proxy password', async () => {
    absolute.length = 0;
    const got = await fetchTextViaEgress(
      new URL('http://shop.com/robots.txt'),
      options(['shop.com']),
    );
    expect(got).toEqual({ status: 200, text: 'plain robots' });
    expect(absolute).toHaveLength(1);
    expect(absolute[0]).toMatch(/^http:\/\/shop\.com\/robots\.txt Basic /);
  });

  it('returns nothing when egress cannot be reached', async () => {
    expect(
      await fetchTextViaEgress(new URL('https://shop.com/robots.txt'), {
        ...options(['shop.com']),
        proxyUrl: 'http://127.0.0.1:1',
      }),
    ).toBeUndefined();
  });
});
