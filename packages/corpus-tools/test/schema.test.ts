// The golden and manifest JSON Schemas accept well-formed files and reject the mistakes the
// format exists to prevent.
import { describe, expect, it } from 'vitest';
import type { GoldenFile, GoldenFinding } from '../src/golden.ts';
import { validate } from '../src/schema.ts';

const linkFinding: GoldenFinding = {
  id: 'header-cart-link',
  ruleId: 'link-name',
  engine: 'axe',
  outcome: 'violation',
  impact: 'serious',
  criteria: ['2.4.4', '4.1.2'],
  category: 'empty-link',
  description: 'The cart icon link has no text.',
  occurrences: [{ page: 'index', selector: 'a.header__cart' }],
  mapping: 'deterministic',
  span: {
    kind: 'element',
    file: 'sections/header.liquid',
    start: 812,
    tag: 'a',
    anchor: '<a href="{{ routes.cart_url }}" class="header__cart">',
  },
  expectedFix: {
    channel: 'theme-patch',
    recipe: 'empty-link',
    outcome: 'fixed',
    targeted: true,
    params: { label: { key: 'accessibility.cart', text: 'Cart' } },
  },
};

const mediaFinding: GoldenFinding = {
  id: 'product-media-alt',
  ruleId: 'rs-media-alt-empty',
  engine: 'rampsmith-data',
  outcome: 'violation',
  impact: 'serious',
  criteria: ['1.1.1'],
  category: 'alt-text-media',
  description: 'A product image has empty alt text.',
  mapping: 'none',
  span: { kind: 'data', resource: 'gid://shopify/MediaImage/1001', field: 'alt' },
  expectedFix: { channel: 'admin-api', recipe: 'media-alt', outcome: 'review', targeted: false },
};

function golden(
  findings: readonly unknown[],
  kind: 'failing' | 'control' | 'store' = 'failing',
): unknown {
  const file: Omit<GoldenFile, 'findings'> & { findings: readonly unknown[] } = {
    $schema: '../schema/golden.schema.json',
    subject: 'aurora',
    kind,
    alignment: { axeCore: '4.14.0', a11yRules: 'b79ba2f', liquidPatch: '551b200' },
    findings,
  };
  return file;
}

const withFix = (fix: Record<string, unknown>): unknown => ({
  ...linkFinding,
  expectedFix: fix,
});

describe('golden schema', () => {
  it('accepts render findings for a theme and data findings for a store, not the reverse', () => {
    expect(validate('golden', golden([linkFinding]))).toEqual([]);
    expect(validate('golden', golden([mediaFinding], 'store'))).toEqual([]);
    expect(validate('golden', golden([mediaFinding]))).not.toEqual([]);
    expect(validate('golden', golden([linkFinding], 'store'))).not.toEqual([]);
  });

  it('accepts * for every page of the theme', () => {
    const everywhere = { ...linkFinding, occurrences: [{ page: '*', selector: 'a.header__cart' }] };
    expect(validate('golden', golden([everywhere]))).toEqual([]);
    const bad = { ...linkFinding, occurrences: [{ page: '**', selector: 'a' }] };
    expect(validate('golden', golden([bad]))).not.toEqual([]);
  });

  it('accepts a control with no findings and rejects one with findings', () => {
    expect(validate('golden', golden([], 'control'))).toEqual([]);
    expect(validate('golden', golden([linkFinding], 'control'))).not.toEqual([]);
  });

  it('requires a refusal code exactly when the outcome is refused', () => {
    expect(
      validate(
        'golden',
        golden([
          withFix({
            channel: 'theme-patch',
            recipe: 'empty-link',
            outcome: 'refused',
            targeted: false,
          }),
        ]),
      ),
    ).not.toEqual([]);
    expect(
      validate(
        'golden',
        golden([
          withFix({
            channel: 'theme-patch',
            recipe: 'empty-link',
            outcome: 'fixed',
            refusal: 'dynamic-content',
            targeted: true,
          }),
        ]),
      ),
    ).not.toEqual([]);
  });

  it('allows a targeted finding only for a theme patch expected to fix it', () => {
    expect(
      validate(
        'golden',
        golden([
          withFix({ channel: 'admin-api', recipe: 'media-alt', outcome: 'fixed', targeted: true }),
        ]),
      ),
    ).not.toEqual([]);
    expect(
      validate(
        'golden',
        golden([
          withFix({
            channel: 'theme-patch',
            recipe: 'empty-link',
            outcome: 'review',
            targeted: true,
          }),
        ]),
      ),
    ).not.toEqual([]);
  });

  it('keeps data-audit findings unrendered and unmapped', () => {
    expect(
      validate(
        'golden',
        golden([{ ...mediaFinding, occurrences: [{ page: 'product', selector: 'img' }] }], 'store'),
      ),
    ).not.toEqual([]);
    expect(
      validate('golden', golden([{ ...mediaFinding, mapping: 'deterministic' }], 'store')),
    ).not.toEqual([]);
    expect(validate('golden', golden([{ ...linkFinding, mapping: 'none' }]))).not.toEqual([]);
    const unrendered = Object.fromEntries(
      Object.entries(linkFinding).filter(([name]) => name !== 'occurrences'),
    );
    expect(validate('golden', golden([unrendered]))).not.toEqual([]);
  });

  it('requires a reason exactly when mapping is ambiguous', () => {
    expect(validate('golden', golden([{ ...linkFinding, mapping: 'ambiguous' }]))).not.toEqual([]);
    expect(
      validate(
        'golden',
        golden([
          { ...linkFinding, mapping: 'ambiguous', ambiguity: 'Two identical links in one file.' },
        ]),
      ),
    ).toEqual([]);
    expect(
      validate('golden', golden([{ ...linkFinding, ambiguity: 'Not ambiguous at all, really.' }])),
    ).not.toEqual([]);
  });

  it('rejects malformed spans, criteria and paths', () => {
    const bad: unknown[] = [
      {
        ...linkFinding,
        span: { kind: 'element', file: 'sections/header.liquid', start: -1, tag: 'a' },
      },
      {
        ...linkFinding,
        span: { kind: 'element', file: 'sections/header.json', start: 1, tag: 'a' },
      },
      {
        ...linkFinding,
        span: { kind: 'element', file: 'other/header.liquid', start: 1, tag: 'a' },
      },
      {
        ...linkFinding,
        span: {
          kind: 'json-value',
          file: 'config/settings_data.json',
          pointer: 'current',
          start: 1,
          end: 2,
        },
      },
      {
        ...linkFinding,
        span: { kind: 'data', resource: 'gid://shopify/Product/1', field: 'body', start: 1 },
      },
      { ...linkFinding, criteria: ['1.4'] },
      { ...linkFinding, criteria: [] },
      { ...linkFinding, id: 'Header Cart' },
      { ...linkFinding, category: 'contrast' },
      { ...linkFinding, extra: true },
    ];
    for (const finding of bad) {
      expect(validate('golden', golden([finding])), JSON.stringify(finding)).not.toEqual([]);
    }
  });
});

describe('manifest schema', () => {
  const manifest = {
    $schema: './schema/manifest.schema.json',
    version: 1,
    renderer: { liquidjs: '10.30.0' },
    checker: {
      axeCore: '4.14.0',
      playwrightCore: '1.64.1',
      tags: ['wcag2a', 'wcag2aa'],
      viewport: { width: 1280, height: 800 },
    },
    stores: [
      {
        name: 'harbor',
        fixtures: 'fixtures/store.json',
        golden: 'golden/store-harbor.json',
        description: 'The store the failing themes render.',
      },
    ],
    themes: [
      {
        name: 'aurora',
        kind: 'failing',
        path: 'themes/aurora',
        store: 'harbor',
        golden: 'golden/aurora.json',
        description: 'A small apparel theme with the failures of a typical theme.',
        variety: ['two-space indentation'],
        pages: [
          { id: 'index', template: 'index', path: '/' },
          { id: 'login', template: 'customers/login', path: '/account/login' },
          {
            id: 'product',
            template: 'product',
            path: '/products/linen-shirt',
            resource: { type: 'product', handle: 'linen-shirt' },
          },
        ],
      },
    ],
  };

  it('accepts a well-formed manifest', () => {
    expect(validate('manifest', manifest)).toEqual([]);
  });

  it('rejects a theme without pages and an unknown resource type', () => {
    const [theme] = manifest.themes;
    expect(validate('manifest', { ...manifest, themes: [{ ...theme, pages: [] }] })).not.toEqual(
      [],
    );
    expect(
      validate('manifest', {
        ...manifest,
        themes: [
          {
            ...theme,
            pages: [
              { id: 'x', template: 'x', path: '/x', resource: { type: 'order', handle: 'x' } },
            ],
          },
        ],
      }),
    ).not.toEqual([]);
  });
});
