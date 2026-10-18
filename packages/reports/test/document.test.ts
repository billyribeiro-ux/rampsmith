import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, ReportDocument, renderSummary } from '../src/index.ts';
import { Html, markup } from '../src/html.ts';
import { summaryInput } from './fixtures.ts';

describe('the report document', () => {
  const doc = renderSummary(summaryInput()).document;

  it('allows exactly its own style sheet: the CSP hash matches the <style> content', () => {
    const style = /<style>([\s\S]*?)<\/style>/u.exec(doc.html)?.[1] ?? '';
    const hash = createHash('sha256').update(style).digest('base64');
    expect(CONTENT_SECURITY_POLICY).toContain(`style-src 'sha256-${hash}'`);
    expect(doc.html.match(/<style>/gu)).toHaveLength(1);
  });

  it('refuses every fetch, script, frame, form and base URL', () => {
    expect(CONTENT_SECURITY_POLICY.split('; ')).toEqual([
      "default-src 'none'",
      expect.stringMatching(/^style-src 'sha256-[A-Za-z0-9+/]{43}='$/u),
      "img-src 'none'",
      "font-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    expect(doc.html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;;',
    );
  });

  it('has no script, image, link, frame or inline style attribute', () => {
    expect(doc.html).not.toMatch(
      /<script|<img|<link|<iframe|<object|<embed|\sstyle=|\son[a-z]+=/iu,
    );
  });

  it('names its language, its title and one h1', () => {
    expect(doc.html).toContain('<html lang="en">');
    expect(doc.html).toContain('<title>Accessibility summary for Example Goods</title>');
    expect(doc.html.match(/<h1>/gu)).toHaveLength(1);
  });

  it('cannot be forged from outside the package', () => {
    expect(() => new ReportDocument(Symbol('ReportDocument'), 'en', 't', '<p>x</p>')).toThrow(
      TypeError,
    );
    expect(() => new Html(Symbol('Html'), '<script>')).toThrow(TypeError);
  });

  it('escapes interpolated text and keeps only package-built markup', () => {
    const hostile = '"><script>alert(1)</script>';
    expect(markup`<p title="${hostile}">${hostile}</p>`.toString()).toBe(
      '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(markup`<div>${markup`<b>${'x'}</b>`}</div>`.toString()).toBe('<div><b>x</b></div>');
  });
});
