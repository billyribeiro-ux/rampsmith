import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  mailtoHref,
  safeWebUrl,
  sanitizeText,
  telHref,
  validEmail,
} from '../src/escape.ts';

describe('escapeHtml', () => {
  it('escapes every character that can open markup or end an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y' \`z\``)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39; &#96;z&#96;',
    );
  });

  it('leaves ordinary text, including non-Latin scripts, unchanged', () => {
    expect(escapeHtml('Café 東京 — 50% off')).toBe('Café 東京 — 50% off');
  });

  it('escapes an existing entity rather than trusting it', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('sanitizeText', () => {
  it('removes control characters but keeps tabs and line feeds', () => {
    expect(sanitizeText('a\u0000b\u0007c\td\ne\u007f\u0085f')).toBe('abc\td\nef');
  });

  it('normalizes CR and CRLF line endings to LF', () => {
    expect(sanitizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('removes bidirectional override and isolate controls that could reorder a report', () => {
    expect(sanitizeText('pay\u202Eevil\u202C safe\u2066x\u2069')).toBe('payevil safex');
  });

  it('replaces lone surrogates so the output is well-formed Unicode', () => {
    expect(sanitizeText('a\uD800b')).toBe('a�b');
  });
});

describe('safeWebUrl', () => {
  it('accepts https and http URLs and returns their serialized form', () => {
    expect(safeWebUrl('https://example.com/accessibility?x=1#y')).toBe(
      'https://example.com/accessibility?x=1#y',
    );
    expect(safeWebUrl('http://example.com')).toBe('http://example.com/');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox',
    'mailto:a@example.com',
    '//example.com',
    '/relative',
    'not a url',
    'https://user:pass@example.com/',
    '',
  ])('refuses %j', (input) => {
    expect(safeWebUrl(input)).toBeUndefined();
  });
});

describe('email and phone links', () => {
  it('accepts an ordinary address and builds a mailto link', () => {
    expect(validEmail('access@example.com')).toBe(true);
    expect(mailtoHref('access@example.com')).toBe('mailto:access@example.com');
  });

  it.each([
    'no-at-sign',
    'a@b',
    'a b@example.com',
    'a@example.com?subject=x',
    'a@example.com\nbcc:x@example.com',
    '"><script>@example.com',
    'a@exa mple.com',
  ])('refuses %j', (input) => {
    expect(validEmail(input)).toBe(false);
    expect(mailtoHref(input)).toBeUndefined();
  });

  it('keeps only digits and a leading plus in a tel link', () => {
    expect(telHref('+1 (555) 010-0199')).toBe('tel:+15550100199');
    expect(telHref('0800 123 456')).toBe('tel:0800123456');
  });

  it('refuses a phone number without enough digits, or with letters', () => {
    expect(telHref('call us')).toBeUndefined();
    expect(telHref('12')).toBeUndefined();
    expect(telHref('555-CALL-NOW')).toBeUndefined();
  });
});
