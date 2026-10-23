/**
 * Fetches a small text document (the free scanner's `robots.txt`) through `egress` (ADR-025,
 * ADR-267): the engine never opens a connection of its own to an address a visitor supplied. A
 * scan token names the hosts the fetch may reach and `egress` checks what they resolve to. A
 * redirect is followed only to another host the token names, at most three times.
 */
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { openTunnel } from './ai/egress-fetch.ts';
import { signScanToken } from './egress-token.ts';

export interface TextResponse {
  readonly status: number;
  readonly text: string;
}

interface TextFetchOptions {
  readonly proxyUrl: string;
  readonly tokenSecret: string;
  /** For egress logs. */
  readonly scanId: string;
  /** Hosts the fetch and its redirects may reach, in the token's form. */
  readonly hosts: readonly string[];
  readonly userAgent: string;
  /** Test seam: an extra CA that signs the site's certificate. */
  readonly ca?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** A way to fetch a text document, replaceable in tests. */
export type TextFetcher = (
  url: URL,
  options: TextFetchOptions,
) => Promise<TextResponse | undefined>;

const MAX_REDIRECTS = 3;

/**
 * One request. An `https` URL runs its TLS session end to end through `tunnel`; an `http` URL
 * goes to egress as an absolute-form request, which is how egress proxies port 80.
 */
function once(
  url: URL,
  options: TextFetchOptions,
  token: string,
  tunnel: Duplex | undefined,
): Promise<{ status: number; location?: string; text: string } | undefined> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const timeout = options.timeoutMs ?? 10_000;
  const headers = {
    accept: 'text/plain, */*;q=0.1',
    'accept-encoding': 'identity',
    'user-agent': options.userAgent,
    host: url.host,
  };
  return new Promise((resolve) => {
    let req: ClientRequest;
    if (tunnel === undefined) {
      const proxy = new URL(options.proxyUrl);
      req = httpRequest({
        host: proxy.hostname,
        port: proxy.port === '' ? 80 : Number(proxy.port),
        method: 'GET',
        path: url.href,
        headers: {
          ...headers,
          'proxy-authorization': `Basic ${Buffer.from(`rampsmith:${token}`).toString('base64')}`,
        },
        timeout,
      });
    } else {
      req = httpsRequest({
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        timeout,
        servername: url.hostname,
        createConnection: () =>
          tlsConnect({
            socket: tunnel,
            servername: url.hostname,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
          }),
      });
    }
    req.once('response', (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          // Past the cap: keep what came, as RFC 9309 §2.5 allows a parser to.
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      const done = () => {
        resolve({
          status,
          ...(location === undefined ? {} : { location }),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      };
      response.once('end', done);
      response.once('close', done);
      response.once('error', () => {
        resolve(undefined);
      });
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.once('error', () => {
      resolve(undefined);
    });
    req.end();
  });
}

/**
 * The document at `url`, or `undefined` when it could not be reached (egress refused, the host
 * did not answer, or the redirects led off the allowed hosts).
 */
export const fetchTextViaEgress: TextFetcher = async (start, options) => {
  const now = options.now ?? Date.now;
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const token = signScanToken(options.tokenSecret, {
      v: 1,
      scan: options.scanId,
      hosts: options.hosts,
      budget: 2,
      exp: Math.floor(now() / 1000) + 120,
    });
    let tunnel: Duplex | undefined;
    if (url.protocol === 'https:') {
      try {
        tunnel = await openTunnel(
          new URL(options.proxyUrl),
          `${url.hostname}:${url.port === '' ? '443' : url.port}`,
          token,
          options.timeoutMs ?? 10_000,
        );
      } catch {
        return undefined;
      }
    }
    const got = await once(url, options, token, tunnel);
    tunnel?.destroy();
    if (got === undefined) return undefined;
    if (got.status >= 300 && got.status < 400 && got.location !== undefined) {
      let next: URL;
      try {
        next = new URL(got.location, url);
      } catch {
        return undefined;
      }
      const allowed = options.hosts.some((entry) =>
        entry.startsWith('.')
          ? next.hostname.endsWith(entry) || next.hostname === entry.slice(1)
          : next.hostname === entry,
      );
      if (!allowed || (next.protocol !== 'https:' && next.protocol !== 'http:')) return undefined;
      url = next;
      continue;
    }
    return { status: got.status, text: got.text };
  }
  return undefined;
};
