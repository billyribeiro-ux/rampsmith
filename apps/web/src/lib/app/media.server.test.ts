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
