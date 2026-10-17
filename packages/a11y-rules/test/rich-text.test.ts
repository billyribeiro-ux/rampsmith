import { describe, expect, it } from 'vitest';
import { auditRichText, type RichTextAudit, type RichTextOptions } from '../src/data/rich-text.ts';
import type { DataFinding } from '../src/types.ts';

const RESOURCE = 'gid://shopify/Product/1';

function audit(html: string, options: RichTextOptions = {}): RichTextAudit {
  return auditRichText({ resource: RESOURCE, field: 'descriptionHtml', html }, options);
}

function findings(html: string, options: RichTextOptions = {}): readonly DataFinding[] {
  const result = audit(html, options);
  if (result.status !== 'audited') throw new Error(`not audited: ${result.reason}`);
  return result.findings;
}

function only(html: string, options: RichTextOptions = {}): DataFinding {
  const all = findings(html, options);
  expect(all).toHaveLength(1);
  const [first] = all;
  if (first === undefined) throw new Error('no finding');
  return first;
}

function slice(html: string, finding: DataFinding): string {
  return html.slice(finding.location.start, finding.location.end);
}

describe('a clean description', () => {
  it('has no findings', () => {
    const html = [
      '<h2>Materials</h2><p>Linen, <strong>washed</strong> for softness.</p>',
      '<h3>Care</h3><ul><li>Cold wash</li></ul>',
      '<p>See the <a href="/pages/size-guide">size guide for this dress</a>.</p>',
      '<img src="/a.jpg" alt="Blue linen dress, front view">',
      '<table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>86 cm</td></tr></table>',
    ].join('');
    expect(findings(html)).toEqual([]);
  });

  it('carries the resource and field through unchanged', () => {
    const result = auditRichText(
      { resource: 'gid://shopify/Page/9', field: 'body', html: '<h4>x</h4>' },
      {},
    );
    expect(result.status).toBe('audited');
    if (result.status !== 'audited') return;
    expect(result.findings[0]?.location.resource).toBe('gid://shopify/Page/9');
    expect(result.findings[0]?.location.field).toBe('body');
  });
});

describe('rs-rich-text-heading-skip', () => {
  it('flags a heading more than one level below the previous one', () => {
    const html = '<h2>Details</h2><p>x</p><h4>Fit</h4>';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-heading-skip');
    expect(f.criteria).toEqual(['1.3.1']);
    expect(f.impact).toBe('moderate');
    expect(f.outcome).toBe('violation');
    expect(f.bestPractice).toBe(true);
    expect(slice(html, f)).toBe('<h4>Fit</h4>');
    expect(f.data).toEqual({ level: 4, previousLevel: 2 });
  });

  it('measures the first heading against the page title level', () => {
    expect(only('<h3>Fit</h3>').data).toEqual({ level: 3, previousLevel: 1 });
    expect(findings('<h3>Fit</h3>', { baseHeadingLevel: 2 })).toEqual([]);
  });

  it('allows going back up and down one level at a time', () => {
    const html = '<h2>a</h2><h3>b</h3><h2>c</h2><h3>d</h3><h4>e</h4><h2>f</h2>';
    expect(findings(html)).toEqual([]);
    const skip = '<h2>a</h2><h3>b</h3><h2>c</h2><h4>d</h4>';
    expect(slice(skip, only(skip))).toBe('<h4>d</h4>');
  });

  it('reads role="heading" with aria-level', () => {
    const html = '<h2>a</h2><div role="heading" aria-level="5">b</div>';
    expect(only(html).data).toEqual({ level: 5, previousLevel: 2 });
  });

  it('ignores headings hidden from assistive technology', () => {
    expect(findings('<h2>a</h2><div hidden><h5>b</h5></div><h3>c</h3>')).toEqual([]);
    expect(findings('<h2>a</h2><h5 aria-hidden="true">b</h5>')).toEqual([]);
  });
});

describe('rs-rich-text-link-empty', () => {
  it('flags a link with no accessible name', () => {
    const html = '<p>Text <a href="/x"> </a></p>';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-link-empty');
    expect(f.criteria).toEqual(['2.4.4', '4.1.2']);
    expect(f.impact).toBe('serious');
    expect(slice(html, f)).toBe('<a href="/x"> </a>');
  });

  it('flags an image-only link whose image has no alt, with the image finding too', () => {
    const ids = findings('<a href="/x"><img src="/a.png"></a>').map((f) => f.ruleId);
    expect(ids).toEqual(['rs-rich-text-link-empty', 'rs-rich-text-img-alt-missing']);
  });

  it('accepts a name from image alt, aria-label, aria-labelledby or title', () => {
    expect(findings('<a href="/x"><img src="/a.png" alt="Size chart"></a>')).toEqual([]);
    expect(findings('<a href="/x" aria-label="Size chart"></a>')).toEqual([]);
    expect(findings('<span id="n">Size chart</span><a href="/x" aria-labelledby="n"></a>')).toEqual(
      [],
    );
    expect(findings('<a href="/x" title="Size chart"></a>')).toEqual([]);
  });

  it('does not count an unresolvable aria-labelledby as a name', () => {
    expect(only('<a href="/x" aria-labelledby="missing"></a>').ruleId).toBe(
      'rs-rich-text-link-empty',
    );
  });

  it('ignores anchors without href', () => {
    expect(findings('<a name="top"></a><a id="x"></a>')).toEqual([]);
  });
});

describe('rs-rich-text-link-vague', () => {
  it('is a violation when the link has no surrounding context', () => {
    const html = '<p><a href="/pages/size">Click here</a></p>';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-link-vague');
    expect(f.criteria).toEqual(['2.4.4']);
    expect(f.outcome).toBe('violation');
    expect(f.data).toEqual({ text: 'click here', hasContext: false });
    expect(slice(html, f)).toBe('<a href="/pages/size">Click here</a>');
  });

  it('needs review when the paragraph may give the purpose', () => {
    const f = only('<p>Our size guide explains fit: <a href="/size">click here</a>.</p>');
    expect(f.outcome).toBe('incomplete');
    expect(f.data).toEqual({ text: 'click here', hasContext: true });
  });

  it('ignores punctuation, case and arrows', () => {
    expect(only('<li><a href="/blog">Read more »</a></li>').data).toEqual({
      text: 'read more',
      hasContext: false,
    });
  });

  it('uses aria-label over the link content', () => {
    expect(findings('<p><a href="/size" aria-label="Size guide">Click here</a></p>')).toEqual([]);
  });

  it('runs for regional English and is skipped, and reported, for unsupported languages', () => {
    expect(only('<p><a href="/x">here</a></p>', { locale: 'en-GB' }).ruleId).toBe(
      'rs-rich-text-link-vague',
    );
    const result = audit('<p><a href="/x">here</a></p>', { locale: 'fr-CA' });
    expect(result.status).toBe('audited');
    expect(result.findings).toEqual([]);
    expect(result.skippedRules).toEqual([
      { ruleId: 'rs-rich-text-link-vague', reason: 'locale_unsupported' },
    ]);
  });

  it('treats a locale named like an object property as unsupported', () => {
    expect(audit('<a href="/x">here</a>', { locale: 'constructor' }).skippedRules).toHaveLength(1);
  });
});

describe('rs-rich-text-img-alt-missing and rs-rich-text-img-alt-filename', () => {
  it('flags an image with no alt attribute as critical', () => {
    const html = '<p>x</p><img src="/a.jpg">';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-img-alt-missing');
    expect(f.criteria).toEqual(['1.1.1']);
    expect(f.impact).toBe('critical');
    expect(slice(html, f)).toBe('<img src="/a.jpg">');
  });

  it('accepts empty alt, a presentation role or another name source', () => {
    expect(findings('<img src="/a.jpg" alt="">')).toEqual([]);
    expect(findings('<img src="/a.jpg" role="presentation">')).toEqual([]);
    expect(findings('<img src="/a.jpg" role="none">')).toEqual([]);
    expect(findings('<img src="/a.jpg" aria-label="Logo">')).toEqual([]);
    expect(findings('<img src="/a.jpg" title="Logo">')).toEqual([]);
  });

  it('flags alt text that is a file name', () => {
    const f = only('<img src="/files/IMG_1234.jpg" alt="IMG_1234.jpg">');
    expect(f.ruleId).toBe('rs-rich-text-img-alt-filename');
    expect(f.impact).toBe('serious');
    expect(f.data).toEqual({ pattern: 'extension' });
    expect(only('<img src="/files/blue-dress.jpg" alt="blue-dress">').data).toEqual({
      pattern: 'matches-file-name',
    });
  });
});

describe('rs-rich-text-table-no-headers', () => {
  it('flags a data table with no header cells', () => {
    const html = '<table><tr><td>S</td><td>M</td></tr><tr><td>86</td><td>90</td></tr></table>';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-table-no-headers');
    expect(f.criteria).toEqual(['1.3.1']);
    expect(f.data).toEqual({ rows: 2, columns: 2 });
    expect(slice(html, f)).toBe(html);
  });

  it('accepts header cells, header roles, single rows or columns and layout tables', () => {
    expect(
      findings('<table><tr><th>S</th><th>M</th></tr><tr><td>86</td><td>90</td></tr></table>'),
    ).toEqual([]);
    expect(
      findings(
        '<table><tr><td role="columnheader">S</td><td>M</td></tr><tr><td>1</td><td>2</td></tr></table>',
      ),
    ).toEqual([]);
    expect(findings('<table><tr><td>S</td><td>M</td></tr></table>')).toEqual([]);
    expect(findings('<table><tr><td>S</td></tr><tr><td>M</td></tr></table>')).toEqual([]);
    expect(
      findings(
        '<table role="presentation"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      ),
    ).toEqual([]);
  });

  it('does not credit a nested table header to the outer table', () => {
    const inner = '<table><tr><th>h</th><th>h</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const html = `<table><tr><td>a</td><td>${inner}</td></tr><tr><td>c</td><td>d</td></tr></table>`;
    const f = only(html);
    expect(f.location.start).toBe(0);
    expect(f.data).toEqual({ rows: 2, columns: 2 });
  });
});

describe('rs-rich-text-color-only', () => {
  it('flags inline text set apart only by colour, for review', () => {
    const html = '<p>Order today, <span style="color: #c00">sale ends Friday</span>.</p>';
    const f = only(html);
    expect(f.ruleId).toBe('rs-rich-text-color-only');
    expect(f.criteria).toEqual(['1.4.1']);
    expect(f.outcome).toBe('incomplete');
    expect(f.data).toEqual({ colour: '#c00' });
    expect(slice(html, f)).toBe('<span style="color: #c00">sale ends Friday</span>');
  });

  it('flags the legacy font colour attribute', () => {
    expect(only('<p>Text <font color="red">sale</font></p>').data).toEqual({ colour: 'red' });
  });

  it('accepts colour combined with weight, style, decoration or background', () => {
    expect(findings('<p>Order <span style="color:red;font-weight:700">now</span></p>')).toEqual([]);
    expect(findings('<p>Order <span style="color:red;font-style:italic">now</span></p>')).toEqual(
      [],
    );
    expect(
      findings('<p>Order <span style="color:red;text-decoration:underline">now</span></p>'),
    ).toEqual([]);
    expect(findings('<p>Order <span style="color:red;background:#ff0">now</span></p>')).toEqual([]);
  });

  it('accepts a distinguishing element wrapping or inside the coloured text', () => {
    expect(findings('<p>Order <strong><span style="color:red">now</span></strong></p>')).toEqual(
      [],
    );
    expect(findings('<p>Order <span style="color:red"><em>now</em></span></p>')).toEqual([]);
  });

  it('ignores coloured text with nothing else in its block, and inherited colours', () => {
    expect(findings('<p><span style="color:red">All of it</span></p>')).toEqual([]);
    expect(findings('<p style="color:red">A <span style="color:red">B</span></p>')).toEqual([]);
    expect(findings('<p>A <span style="color: inherit">B</span></p>')).toEqual([]);
  });

  it('reports a nested run of the same colour once', () => {
    const html = '<p>A <span style="color:red">B <span style="color:red">C</span></span></p>';
    expect(findings(html)).toHaveLength(1);
  });
});

describe('locations', () => {
  it('are UTF-16 offsets that survive CRLF line endings and astral characters', () => {
    const html = '😀 line\r\n<h2>a</h2>\r\n<h5>😀</h5>';
    const f = only(html);
    expect(slice(html, f)).toBe('<h5>😀</h5>');
  });
});

describe('limits', () => {
  it('refuses input over the size limit without parsing it', () => {
    const result = audit('<p>x</p>', { limits: { maxLength: 4 } });
    expect(result).toMatchObject({ status: 'not_audited', reason: 'too_large', findings: [] });
  });

  it('refuses nesting deeper than the depth limit, quickly', () => {
    const started = performance.now();
    const result = audit('<div>'.repeat(100_000));
    expect(result).toMatchObject({ status: 'not_audited', reason: 'too_deep' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('counts nesting inside template contents', () => {
    const result = audit('<template><div>'.repeat(400));
    expect(result).toMatchObject({ status: 'not_audited', reason: 'too_deep' });
  });

  it('refuses a tag with more attributes than the attribute limit, quickly', () => {
    // parse5's duplicate-attribute check is quadratic in a tag's attribute count.
    const names = Array.from({ length: 40_000 }, (_, i) => `a${i.toString(36)}`).join(' ');
    for (const html of [`<div ${names}>x</div>`, `<div x"y ${names}>`, `</p ${names}>`]) {
      const started = performance.now();
      expect(audit(html)).toMatchObject({ status: 'not_audited', reason: 'too_many_attributes' });
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  it('stays fast at the limit: a megabyte of tags with the most attributes allowed', () => {
    const tag = `<i ${Array.from({ length: 256 }, (_, i) => `a${i.toString(36)}`).join(' ')}></i>`;
    const html = tag.repeat(Math.floor(1_000_000 / tag.length));
    const started = performance.now();
    const result = audit(html);
    expect(['audited', 'not_audited']).toContain(result.status);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('counts attributes the way the HTML tokenizer does', () => {
    const many = (n: number, sep: string): string =>
      Array.from({ length: n }, (_, i) => `a${String(i)}${sep}`).join(' ');
    // Quoted values may hold anything, including spaces and '>'.
    expect(
      audit(`<p ${many(10, '="x > y z"')}>t</p>`, { limits: { maxAttributes: 10 } }).status,
    ).toBe('audited');
    expect(audit(`<p ${many(11, '=1')}>t</p>`, { limits: { maxAttributes: 10 } })).toMatchObject({
      reason: 'too_many_attributes',
    });
    // Repeated names still cost a comparison each, so they count too.
    expect(audit(`<p ${'a=1 '.repeat(11)}>t</p>`, { limits: { maxAttributes: 10 } })).toMatchObject(
      {
        reason: 'too_many_attributes',
      },
    );
  });

  it('refuses more elements than the element limit', () => {
    const result = audit('<br>'.repeat(50), { limits: { maxElements: 10 } });
    expect(result).toMatchObject({ status: 'not_audited', reason: 'too_many_elements' });
  });

  it('stops at the time budget', () => {
    const result = audit('<p>a</p>'.repeat(5_000), { limits: { timeBudgetMs: -1 } });
    expect(result).toMatchObject({ status: 'not_audited', reason: 'time_limit' });
  });
});
