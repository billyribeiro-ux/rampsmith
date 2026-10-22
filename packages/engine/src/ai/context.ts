/**
 * Finds one image's context in the store data `ctl` read (`scan_inputs`, ADR-035): the media
 * id, its URL and current alt text, and the product's title and type. The payload is store
 * content, so it is treated as untrusted: every member is type-checked and nothing is trusted
 * to have the expected shape (ADR-090 records the shape lane A's `shopify.read_store` writes).
 */

export interface ImageContext {
  readonly url: string;
  /** The alt text the image has now; `null` when it has none. */
  readonly currentAlt: string | null;
  readonly productTitle: string;
  readonly productType: string;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A list given plainly or as a GraphQL connection (`{ nodes: [...] }` or `{ edges }`). */
function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const connection = record(value);
  if (connection === undefined) return [];
  if (Array.isArray(connection['nodes'])) return connection['nodes'] as unknown[];
  if (Array.isArray(connection['edges'])) {
    return (connection['edges'] as unknown[]).map((edge) => record(edge)?.['node']);
  }
  return [];
}

function imageOf(media: Json): { url: string; alt: string | null } | undefined {
  const nested = record(media['image']);
  const url = text(nested?.['url']) ?? text(media['url']);
  if (url === undefined) return undefined;
  const alt = text(media['alt']) ?? text(nested?.['altText']) ?? null;
  return { url, alt: alt === '' ? null : alt };
}

/**
 * Looks `gid` up in a `products` input row: `{ products: [{ id, title, productType, media }] }`
 * where `media` is a list or connection of `{ id, alt, image: { url } }`.
 */
export function findImageContext(payload: unknown, gid: string): ImageContext | undefined {
  const root = record(payload);
  if (root === undefined) return undefined;
  for (const entry of list(root['products'])) {
    const product = record(entry);
    if (product === undefined) continue;
    for (const item of list(product['media'])) {
      const media = record(item);
      if (media?.['id'] !== gid) continue;
      const image = imageOf(media);
      if (image === undefined) return undefined;
      return {
        url: image.url,
        currentAlt: image.alt,
        productTitle: text(product['title']) ?? '',
        productType: text(product['productType']) ?? '',
      };
    }
  }
  return undefined;
}

/** The shop's primary locale from the `shop` input row, `en` when it does not say. */
export function primaryLocaleOf(payload: unknown): string {
  const root = record(payload);
  const direct = text(root?.['primaryLocale']) ?? text(record(root?.['shop'])?.['primaryLocale']);
  return direct !== undefined && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(direct)
    ? direct
    : 'en';
}
