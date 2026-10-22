import { describe, expect, it } from 'vitest';
import { parsePublicUrl } from './url.ts';

function ok(input: string) {
  const parsed = parsePublicUrl(input);
  if (!parsed.ok) throw new Error(`expected ${input} to be accepted, got ${parsed.reason}`);
  return parsed;
}

describe('parsePublicUrl accepts public sites', () => {
  it('adds https when the visitor leaves the scheme out', () => {
    expect(ok('example.com').origin).toBe('https://example.com/');
  });

  it('keeps http, and reduces the address to the home page', () => {
    const parsed = ok('http://Shop.Example.com/products/a?x=1#top');
    expect(parsed.origin).toBe('http://shop.example.com/');
    expect(parsed.domain).toBe('shop.example.com');
  });

  it('keys the domain without a leading www', () => {
    expect(ok('https://www.example.com').domain).toBe('example.com');
  });

  it('trims whitespace and a trailing dot, and accepts the default ports', () => {
    expect(ok('  https://example.com.:443/ ').origin).toBe('https://example.com/');
    expect(ok('http://example.com:80').origin).toBe('http://example.com/');
  });

  it('accepts internationalised names in their ASCII form', () => {
    expect(ok('https://bücher.com').domain).toBe('xn--bcher-kva.com');
  });
});

describe('parsePublicUrl refuses what is not a public website', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['ftp://example.com', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'invalid'],
    ['https://user:pass@example.com', 'credentials'],
    ['https://example.com:8443', 'port'],
    ['https://example.com:22', 'port'],
    ['https://localhost', 'private'],
    ['https://intranet', 'private'],
    ['https://printer.local', 'private'],
    ['https://db.internal', 'private'],
    ['https://foo.localhost', 'private'],
    ['https://127.0.0.1', 'address'],
    ['https://2130706433', 'address'],
    ['https://0x7f.1', 'address'],
    ['https://10.0.0.5/', 'address'],
    ['https://169.254.169.254/latest', 'address'],
    ['https://[::1]/', 'address'],
    ['https://[fd00::1]/', 'address'],
    ['https://exa mple.com', 'invalid'],
    ['https://-bad.example.com', 'invalid'],
    ['https://example..com', 'invalid'],
  ])('%s is refused as %s', (input, reason) => {
    const parsed = parsePublicUrl(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(reason);
  });

  it('refuses very long input', () => {
    expect(parsePublicUrl(`https://${'a'.repeat(3000)}.example.com`).ok).toBe(false);
  });
});
