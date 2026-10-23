import { describe, expect, it } from 'vitest';
import { fetchMedia, MAX_MEDIA_BYTES, mediaUrl } from './media.server.ts';

describe('mediaUrl', () => {
  it('accepts a Shopify CDN file and rebuilds the address from known parts', () => {
    const url = mediaUrl(
      'https://cdn.shopify.com/s/files/1/0001/0002/products/mug.jpg?v=1700000000&evil=1#frag',
    );
    expect(url?.toString()).toBe(
      'https://cdn.shopify.com/s/files/1/0001/0002/products/mug.jpg?v=1700000000&width=240',
    );
  });

  it.each([
    null,
    '',
    'not a url',
    'http://cdn.shopify.com/s/files/1/a.jpg',
    'https://evil.example/s/files/1/a.jpg',
    'https://cdn.shopify.com.evil.example/s/files/1/a.jpg',
    'https://cdn.shopify.com@evil.example/s/files/1/a.jpg',
    'https://user:pw@cdn.shopify.com/s/files/1/a.jpg',
    'https://cdn.shopify.com:8443/s/files/1/a.jpg',
    'https://cdn.shopify.com/shopifycloud/app-bridge.js',
    'https://cdn.shopify.com/s/filesx/a.jpg',
    'https://127.0.0.1/s/files/1/a.jpg',
    `https://cdn.shopify.com/s/files/${'a'.repeat(2100)}`,
  ])('refuses %j', (raw) => {
    expect(mediaUrl(raw)).toBeUndefined();
  });

  it('ignores a version that is not digits', () => {
    expect(mediaUrl('https://cdn.shopify.com/s/files/1/a.jpg?v=../x')?.search).toBe('?width=240');
  });
});

describe('fetchMedia', () => {
  const url = new URL('https://cdn.shopify.com/s/files/1/a.jpg');
  const answer =
    (body: BodyInit | null, headers: Record<string, string>, status = 200) =>
    () =>
      Promise.resolve(new Response(body, { status, headers }));

  it('returns raster images', async () => {
    const result = await fetchMedia(
      url,
      answer(new Uint8Array([1, 2, 3]), { 'content-type': 'image/jpeg' }),
    );
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]), type: 'image/jpeg' });
  });

  it('refuses SVG, HTML and unknown types, which could carry script', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', '']) {
      const result = await fetchMedia(url, answer('<svg/>', { 'content-type': type }));
      expect(result, type).toEqual({ ok: false, status: 415 });
    }
  });

  it('refuses a file over the size limit, declared or streamed', async () => {
    const declared = await fetchMedia(
      url,
      answer('x', { 'content-type': 'image/png', 'content-length': String(MAX_MEDIA_BYTES + 1) }),
    );
    expect(declared).toEqual({ ok: false, status: 413 });
    const streamed = await fetchMedia(
      url,
      answer(new Uint8Array(MAX_MEDIA_BYTES + 1), { 'content-type': 'image/png' }),
    );
    expect(streamed).toEqual({ ok: false, status: 413 });
  });

  it('maps a missing file and a failing CDN', async () => {
    expect(await fetchMedia(url, answer('', {}, 404))).toEqual({ ok: false, status: 404 });
    expect(await fetchMedia(url, answer('', {}, 500))).toEqual({ ok: false, status: 502 });
    expect(await fetchMedia(url, () => Promise.reject(new Error('redirect')))).toEqual({
      ok: false,
      status: 502,
    });
  });

  it('asks for no redirects', async () => {
    let seen: RequestInit | undefined;
    await fetchMedia(url, (_u, init) => {
      seen = init;
      return Promise.resolve(new Response('', { status: 404 }));
    });
    expect(seen?.redirect).toBe('error');
  });
});

describe('fetchMedia closes every response it does not read (security audit L4)', () => {
  const url = new URL('https://cdn.shopify.com/s/files/1/a.jpg');

  /** A response whose body reports when it is cancelled. */
  function watched(status: number, headers: Record<string, string>) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      response: new Response(body, { status, headers }),
      cancelled: () => cancelled,
    };
  }

  it.each([
    ['a missing file', 404, { 'content-type': 'image/jpeg' }, 404],
    ['a CDN error', 500, { 'content-type': 'image/jpeg' }, 502],
    ['a type that is not a raster image', 200, { 'content-type': 'text/html' }, 415],
    [
      'a declared size over the limit',
      200,
      { 'content-type': 'image/jpeg', 'content-length': String(MAX_MEDIA_BYTES + 1) },
      413,
    ],
  ] as const)('cancels the body of %s', async (_name, status, headers, expected) => {
    const seen = watched(status, headers);
    const result = await fetchMedia(url, () => Promise.resolve(seen.response));
    expect(result).toEqual({ ok: false, status: expected });
    expect(seen.cancelled()).toBe(true);
  });

  it('cancels a download that runs past the limit, and one that is cut off', async () => {
    const endless = watched(200, { 'content-type': 'image/png' });
    // The stream above never ends: the size check must stop it.
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        endless.cancelled();
      },
    });
    const result = await fetchMedia(url, () =>
      Promise.resolve(new Response(big, { headers: { 'content-type': 'image/png' } })),
    );
    expect(result).toEqual({ ok: false, status: 413 });

    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('reset'));
      },
    });
    const cut = await fetchMedia(url, () =>
      Promise.resolve(new Response(broken, { headers: { 'content-type': 'image/png' } })),
    );
    expect(cut).toEqual({ ok: false, status: 502 });
  });
});
