/**
 * The media route's rules (ADR-092). The embedded page's CSP allows images from `self` and
 * `data:` only, and a product image lives on Shopify's CDN, so the BFF fetches it and returns
 * the bytes. The URL comes from the browser, so it is the one place a request could be steered:
 * the host, scheme, path prefix and size are pinned, redirects are refused, and only raster
 * types are returned.
 */
const MEDIA_HOST = 'cdn.shopify.com';
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const TIMEOUT_MS = 10_000;

/** The CDN URL to fetch for a requested image, or `undefined` if it may not be fetched. */
export function mediaUrl(raw: string | null, width = 240): URL | undefined {
  if (raw === null || raw.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== MEDIA_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith('/s/files/')
  ) {
    return undefined;
  }
  // Only the version query and a width: nothing else of the caller's reaches the CDN.
  const out = new URL(`https://${MEDIA_HOST}${url.pathname}`);
  const version = url.searchParams.get('v');
  if (version !== null && /^\d{1,20}$/u.test(version)) out.searchParams.set('v', version);
  out.searchParams.set('width', String(width));
  return out;
}

type Fetch = typeof globalThis.fetch;

export type MediaResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }
  | { readonly ok: false; readonly status: 400 | 404 | 413 | 415 | 502 };

export async function fetchMedia(url: URL, fetchImpl: Fetch = fetch): Promise<MediaResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    });
  } catch {
    return { ok: false, status: 502 };
  }
  if (response.status === 404) return { ok: false, status: 404 };
  if (!response.ok) return { ok: false, status: 502 };
  const type =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!RASTER.has(type)) return { ok: false, status: 415 };
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_MEDIA_BYTES) return { ok: false, status: 413 };
  const reader = response.body?.getReader();
  if (reader === undefined) return { ok: false, status: 502 };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, type };
}
