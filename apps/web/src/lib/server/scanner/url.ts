/**
 * The free scanner's input rules (PLAN §16): one public website, scanned at its home page.
 *
 * This is the first, syntactic guard. It keeps obviously private targets (IP addresses,
 * single-label and reserved names, unusual ports, credentials) from ever reaching the scanner.
 * The request-forgery guard that resolves DNS and pins the connection lives in the engine's
 * egress path and still runs on every request (PLAN §18); nothing here replaces it.
 */

export type UrlRefusal =
  'empty' | 'invalid' | 'scheme' | 'credentials' | 'port' | 'address' | 'private';

export type ParsedPublicUrl =
  | {
      readonly ok: true;
      /** The home page to scan: scheme, host and a bare `/`. */
      readonly origin: string;
      /** The host, lower-cased and without a leading `www.`; the key for per-domain limits. */
      readonly domain: string;
    }
  | { readonly ok: false; readonly reason: UrlRefusal };

const MAX_INPUT = 2048;
const MAX_HOST = 253;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Top-level names that never point at the public internet. */
const RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'test',
  'example',
  'invalid',
  'onion',
  'arpa',
];

const refuse = (reason: UrlRefusal): ParsedPublicUrl => ({ ok: false, reason });

export function parsePublicUrl(input: string): ParsedPublicUrl {
  const text = input.trim();
  if (text === '') return refuse('empty');
  if (text.length > MAX_INPUT) return refuse('invalid');
  if (/\s/u.test(text)) return refuse('invalid');

  let candidate = text;
  if (!/^https?:\/\//iu.test(text)) {
    if (text.includes('://')) return refuse('scheme');
    candidate = `https://${text}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refuse('invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('scheme');
  if (url.username !== '' || url.password !== '') return refuse('credentials');
  if (url.port !== '') return refuse('port');

  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (host === '' || host.length > MAX_HOST) return refuse('invalid');
  // WHATWG URL normalises decimal, octal and hexadecimal IPv4 forms to dotted decimal and
  // keeps IPv6 in brackets, so these two checks cover every spelling of an address.
  if (host.startsWith('[') || host.includes(':')) return refuse('address');
  const labels = host.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (/^[0-9]+$/u.test(tld) || /^0x[0-9a-f]*$/iu.test(tld)) return refuse('address');
  if (!labels.every((label) => LABEL.test(label))) return refuse('invalid');
  if (labels.length < 2) return refuse('private');
  if (RESERVED_SUFFIXES.includes(tld)) return refuse('private');

  return {
    ok: true,
    origin: `${url.protocol}//${host}/`,
    domain: host.replace(/^www\./u, ''),
  };
}
