/**
 * Keeps addresses, tokens and shop names out of exported spans (audit M2, PLAN §19, §21).
 *
 * SvelteKit's root span records `http.url` as the full request URL. On the embedded app that
 * URL carries Shopify's launch parameters (`id_token`, `hmac`, `session`, `shop`, `host`), and a
 * session token in a trace backend is a session token an attacker can replay for a minute. The
 * processor in this file rewrites, before any exporter sees the span:
 *
 * - URL-valued attributes (`http.url`, `url.full`, `http.target`, `http.request.header.referer`,
 *   `http.response.header.location`, anything whose name ends in `url`, `uri`, `target`,
 *   `referer`, `referrer` or `location`) to origin plus path, without credentials, query or
 *   fragment;
 * - every other string attribute, event attribute (exception messages and stack traces) and link
 *   attribute: URLs inside the text get the same treatment, and `*.myshopify.com` host names
 *   become `[shop].myshopify.com` (PLAN §19: ids, never names);
 * - attributes that are secrets by name (`url.query`, `url.fragment`, cookie, authorization,
 *   `x-shopify-hmac-sha256`, `password`, `token`…) to `[redacted]`.
 *
 * Text is hostile (a page or a caller chooses it), so nothing here backtracks.
 */
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const REDACTED = '[redacted]';
const SHOP_SUFFIX = /\.myshopify\.com\b/gi;
const SHOP_LABEL = /[a-z0-9-]/i;
const SHOP_PLACEHOLDER = '[shop].myshopify.com';
/** `scheme://rest`, with a scheme as RFC 3986 spells it and a bounded length. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,30}:\/\/[^\s"'<>`{}|\\^]+/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', ')', ']']);

/** Attribute names whose value is an address, or part of one. */
const URL_KEY = /(^|\.)(url|uri|target|referer|referrer|location|original|full)$/i;
/** Attribute names whose whole value is secret, whatever it looks like. */
const SECRET_KEY =
  /(^|\.)(query|query_string|fragment|password|passwd|secret|api[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|token|authorization|proxy-authorization|cookie|set-cookie|hmac|x-shopify-hmac-sha256|x-shopify-access-token)$/i;

/**
 * An address without credentials, query string and fragment. Absolute addresses keep scheme,
 * host (with a port) and path; `data:` and `mailto:` style addresses keep the scheme only;
 * anything relative keeps its path.
 */
export function redactUrl(value: string): string {
  if (SCHEME.test(value)) {
    try {
      const url = new URL(value);
      if (!value.slice(url.protocol.length).startsWith('//')) return url.protocol;
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      // Not a parseable address: fall through and cut it where a query or fragment starts.
    }
  }
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Replaces `<label>.myshopify.com` with `[shop].myshopify.com`, in one pass over the text. */
function redactShops(text: string): string {
  let out = '';
  let copied = 0;
  for (const match of text.matchAll(SHOP_SUFFIX)) {
    let start = match.index;
    while (start > copied && SHOP_LABEL.test(text.charAt(start - 1))) start -= 1;
    if (start === match.index) continue;
    out += text.slice(copied, start) + SHOP_PLACEHOLDER;
    copied = match.index + match[0].length;
  }
  return out + text.slice(copied);
}

/** Free text with each URL reduced to origin plus path and each shop name hidden. */
export function redactText(text: string): string {
  const urls = text.replaceAll(URL_IN_TEXT, (match) => {
    let end = match.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(match.charAt(end - 1))) end -= 1;
    return redactUrl(match.slice(0, end)) + match.slice(end);
  });
  return redactShops(urls);
}

function redactValue(key: string, value: AttributeValue): AttributeValue {
  if (SECRET_KEY.test(key)) return REDACTED;
  const one = (text: string) =>
    URL_KEY.test(key) ? redactText(redactUrl(text)) : redactText(text);
  if (typeof value === 'string') return one(value);
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? one(item) : item)) as AttributeValue;
  }
  return value;
}

/** Rewrites `attributes` in place. */
function redactRecord(attributes: Attributes | undefined): void {
  if (attributes === undefined) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    const redacted = redactValue(key, value);
    if (JSON.stringify(redacted) !== JSON.stringify(value)) attributes[key] = redacted;
  }
}

function redactSpan(span: ReadableSpan): void {
  redactRecord(span.attributes);
  for (const event of span.events) redactRecord(event.attributes);
  for (const link of span.links) redactRecord(link.attributes);
}

/**
 * A span processor that must come first in the list, so that processors which export while a
 * span ends (`SimpleSpanProcessor`) and processors which keep a reference and export later
 * (`BatchSpanProcessor`) both see redacted spans. It rewrites when the span starts (attributes
 * given at creation), when it is about to end (`onEnding`: late attributes, exception events)
 * and once more in `onEnd`, in case an SDK version stops calling the experimental `onEnding`.
 * The SDK keeps attributes in a plain object on the span, so rewriting happens in place.
 */
export class UrlRedactingSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    redactSpan(span);
  }

  onEnding(span: Span): void {
    redactSpan(span);
  }

  onEnd(span: ReadableSpan): void {
    redactSpan(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
