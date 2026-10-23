/**
 * Downloads one product image through `egress` (ADR-035, ADR-025): the engine never opens a
 * connection of its own to a merchant-supplied address. A scan token names the one host the
 * download may reach; `egress` checks the resolved addresses and the connection budget, and
 * the TLS session runs end to end between this process and the image host.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { JobFailure } from '@rampsmith/queue';
import { signScanToken } from '../egress-token.ts';

/** Hosts that serve Shopify product media (the Admin API's `image.url`). */
const IMAGE_HOSTS: readonly string[] = ['cdn.shopify.com'];

/** The largest image the engine downloads. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export interface EgressFetchOptions {
  readonly proxyUrl: string;
  readonly tokenSecret: string;
  /** The scan the image belongs to, for egress logs. */
  readonly scanId: string;
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  /** Test seam: an extra CA that signs the image host's certificate. */
  readonly ca?: string;
  readonly now?: () => number;
  /** Aborts the download and closes the tunnel, for example when the job lost its lease. */
  readonly signal?: AbortSignal;
}

function failure(kind: 'retryable' | 'permanent', code: string, message: string): JobFailure {
  return new JobFailure(kind, { code, message });
}

/** The image URL must be https, on a Shopify media host, with no credentials or odd port. */
export function checkImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw failure('permanent', 'image_url_invalid', 'the image URL does not parse');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !IMAGE_HOSTS.includes(url.hostname)
  ) {
    throw failure('permanent', 'image_url_off_host', 'the image is not on a Shopify media host');
  }
  return url;
}

function openTunnel(proxy: URL, authority: string, token: string, timeoutMs: number) {
  return new Promise<Duplex>((resolve, reject) => {
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        'proxy-authorization': `Basic ${Buffer.from(`rampsmith:${token}`).toString('base64')}`,
      },
      timeout: timeoutMs,
    });
    connect.once('connect', (response: IncomingMessage, socket: Duplex) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      const status = response.statusCode ?? 0;
      reject(
        status === 403 || status === 407
          ? failure('permanent', 'egress_refused', `egress refused the tunnel (${String(status)})`)
          : failure('retryable', 'egress_unavailable', `egress answered ${String(status)}`),
      );
    });
    connect.once('timeout', () => {
      connect.destroy();
      reject(failure('retryable', 'egress_timeout', 'egress did not answer in time'));
    });
    connect.once('error', () => {
      reject(failure('retryable', 'egress_unreachable', 'egress could not be reached'));
    });
    connect.end();
  });
}

/** The image bytes, or a `JobFailure` that says whether trying again could help. */
export async function fetchImageViaEgress(
  imageUrl: string,
  options: EgressFetchOptions,
): Promise<Buffer> {
  const url = checkImageUrl(imageUrl);
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const token = signScanToken(options.tokenSecret, {
    v: 1,
    scan: options.scanId,
    hosts: [url.hostname],
    budget: 2,
    exp: Math.floor(now() / 1000) + 120,
  });
  const tunnel = await openTunnel(
    new URL(options.proxyUrl),
    `${url.hostname}:443`,
    token,
    timeoutMs,
  );
  return new Promise<Buffer>((resolve, reject) => {
    const aborted = (): void => {
      tunnel.destroy();
      reject(failure('retryable', 'image_fetch_aborted', 'the download was aborted'));
    };
    if (options.signal?.aborted === true) {
      aborted();
      return;
    }
    options.signal?.addEventListener('abort', aborted, { once: true });
    const req = httpsRequest(
      {
        host: url.hostname,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: 'image/*', 'accept-encoding': 'identity' },
        // The TLS session runs end to end through the tunnel `egress` opened.
        createConnection: () =>
          tlsConnect({
            socket: tunnel,
            servername: url.hostname,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
          }),
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          tunnel.destroy();
          const transient = status === 429 || status >= 500;
          reject(
            failure(
              transient ? 'retryable' : 'permanent',
              'image_fetch_failed',
              `the image host answered ${String(status)}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            tunnel.destroy();
            reject(failure('permanent', 'image_too_large', 'the image is larger than the limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          tunnel.destroy();
          resolve(Buffer.concat(chunks));
        });
        response.once('error', () => {
          reject(failure('retryable', 'image_fetch_failed', 'the image download was cut off'));
        });
      },
    );
    options.signal?.addEventListener(
      'abort',
      () => {
        req.destroy();
      },
      { once: true },
    );
    req.once('timeout', () => {
      req.destroy();
      tunnel.destroy();
      reject(failure('retryable', 'image_fetch_timeout', 'the image host did not answer in time'));
    });
    req.once('error', () => {
      tunnel.destroy();
      reject(failure('retryable', 'image_fetch_failed', 'the image could not be downloaded'));
    });
    req.end();
  });
}
