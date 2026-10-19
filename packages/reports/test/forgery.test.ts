// The package's trusted types cannot be forged from outside, and errors never carry a whole
// hostile input (security audit findings 4, 5 and 6).
import { describe, expect, it } from 'vitest';
import {
  remediationLogJson,
  renderStatement,
  ReportDocument,
  ReportInputError,
  type RemediationEntry,
} from '../src/index.ts';
import { blocksToHtml, Link } from '../src/blocks.ts';
import { Html, join, markup } from '../src/html.ts';
import { quote } from '../src/validate.ts';
import { remediationInput, statementInput } from './fixtures.ts';

describe('trusted types', () => {
  it('refuses an object made from Html.prototype or one that only looks like Html', () => {
    const fake = Object.create(Html.prototype) as Html;
    expect(Html.is(fake)).toBe(false);
    expect(() => markup`<p>${fake}</p>`).toThrow(TypeError);
    const lookalike = { toString: () => '<script>alert(1)</script>' } as unknown as Html;
    expect(() => join([lookalike])).toThrow(TypeError);
    expect(join([markup`<b>${'x'}</b>`, markup`<i></i>`]).toString()).toBe('<b>x</b><i></i>');
  });

  it('freezes Html, Link and ReportDocument so they cannot be altered', () => {
    const doc = renderStatement(statementInput()).document;
    expect(Object.isFrozen(doc)).toBe(true);
    expect(() => {
      (doc as unknown as { html: string }).html = '<p>swapped</p>';
    }).toThrow(TypeError);
    expect(Object.isFrozen(markup`<p></p>`)).toBe(true);
  });

  it('does not accept a look-alike document', () => {
    const fake = Object.create(ReportDocument.prototype) as ReportDocument;
    expect(ReportDocument.is(fake)).toBe(false);
    expect(ReportDocument.is({ lang: 'en', title: 't', html: '<p>x</p>' })).toBe(false);
    expect(ReportDocument.is(renderStatement(statementInput()).document)).toBe(true);
  });

  it('refuses a forged link instead of rendering its href', () => {
    const fake = Object.defineProperties(Object.create(Link.prototype) as object, {
      href: { value: 'javascript:alert(1)' },
      label: { value: 'x' },
    }) as Link;
    expect(Link.is(fake)).toBe(false);
    expect(() => blocksToHtml([{ kind: 'paragraph', content: [fake] }])).toThrow(TypeError);
  });
});

describe('the remediation log keeps only the fields it defines', () => {
  it('rebuilds a system approver, dropping anything else the caller attached', () => {
    const [entry] = remediationInput().entries;
    if (entry === undefined) throw new Error('fixture');
    const approver = { kind: 'system', sessionToken: 'secret-token', email: 'a@example.com' };
    const json = remediationLogJson(
      remediationInput({ entries: [{ ...entry, approver } as unknown as RemediationEntry] }),
    );
    expect(json).not.toContain('secret-token');
    expect(json).not.toContain('a@example.com');
    expect(JSON.parse(json)).toMatchObject({ entries: [{ approvedBy: { kind: 'system' } }] });
  });

  it('refuses an approver of an unknown kind', () => {
    const [entry] = remediationInput().entries;
    if (entry === undefined) throw new Error('fixture');
    const approver = { kind: 'admin', name: 'x' };
    expect(() =>
      remediationLogJson(
        remediationInput({ entries: [{ ...entry, approver } as unknown as RemediationEntry] }),
      ),
    ).toThrow(/entries\[0\]\.approver\.kind/u);
  });
});

describe('error messages', () => {
  it('quote a value in at most 40 characters on one line', () => {
    expect(quote('short')).toBe('"short"');
    expect(quote('a'.repeat(50))).toBe(`"${'a'.repeat(40)}…"`);
    expect(quote('a\r\nforged log line\u2028b')).toBe('"a\\r\\nforged log line\\u2028b"');
  });

  it('never echo a huge or multi-line hostile value', () => {
    const hostile = `9.9.9\n${'x'.repeat(100_000)}`;
    let error: unknown;
    try {
      renderStatement(
        statementInput({
          coverage: { automated: [hostile], partial: [], rulesetVersion: 'v' },
        }),
      );
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReportInputError);
    const message = (error as Error).message;
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain('\n');
  });

  it('refuses a single-line field holding a Unicode line separator', () => {
    expect(() => renderStatement(statementInput({ organization: 'Good\u2028Evil' }))).toThrow(
      /organization: must be a single line/u,
    );
  });
});

describe('the trusted classes cannot be patched', () => {
  it('freezes the classes and their prototypes', () => {
    for (const cls of [Html, Link, ReportDocument]) {
      expect(Object.isFrozen(cls)).toBe(true);
      expect(Object.isFrozen(cls.prototype)).toBe(true);
    }
    expect(() => {
      (ReportDocument as unknown as { is: () => boolean }).is = () => true;
    }).toThrow(TypeError);
  });

  it('renders an array through Array.from, ignoring a replaced map', () => {
    const items = ['<b>'] as string[] & { map?: unknown };
    Object.defineProperty(items, 'map', { value: () => ['<script>alert(1)</script>'] });
    expect(markup`<p>${items}</p>`.toString()).toBe('<p>&lt;b&gt;</p>');
  });

  it('escapes bidirectional and invisible characters in quoted values', () => {
    expect(quote('a\u202Eb\u2066c\u200Bd')).toBe('"a\\u202eb\\u2066c\\u200bd"');
  });
});
