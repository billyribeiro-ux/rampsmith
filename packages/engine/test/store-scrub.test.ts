/** Audit L10 (PLAN §19): hostile selectors and addresses, written through `recordPage` to PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { fingerprint } from '../src/fingerprint.ts';
import type { Occurrence, PageScan } from '../src/scan-page.ts';
import { recordPage } from '../src/store.ts';
import { freshDatabase, seed, type TestDatabase } from './db.ts';

let db: TestDatabase;
let worker: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  worker = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

const SECRETS = [
  'shopper@example.com',
  'jane.doe',
  'eyJhbGciOiJIUzI1NiJ9',
  'id_token',
  'hmac=00ff',
  '4111111111111111',
  'reset-key',
  'frag-secret',
  's3cret',
];

const SECTION = 'shopify-section-template--1234__main';

function occurrence(target: string): Occurrence {
  return {
    ruleId: 'image-alt',
    impact: 'critical',
    criteria: ['1.1.1'],
    help: 'Images must have alternative text',
    target,
    html: '<img src="a.png" alt="" data-owner="shopper@example.com">',
    section: SECTION,
  };
}

function page(url: string, violations: Occurrence[], finalUrl: string = url): PageScan {
  return {
    url,
    finalUrl,
    status: 200,
    blocked: undefined,
    violations,
    incomplete: [],
    durationMs: 10,
  };
}

describe('recordPage scrubs what it stores', () => {
  it('keeps no token or personal data in the stored selector, address or excerpt', async () => {
    const f = await seed(db.owner, 'https://scrub.myshopify.com', { pages: 1 });
    const finalUrl =
      'https://user:s3cret@scrub.myshopify.com/account/jane.doe@example.com/orders' +
      '?id_token=eyJhbGciOiJIUzI1NiJ9&hmac=00ff&card=4111111111111111#frag-secret';
    await recordPage(
      worker,
      f,
      page(
        'https://scrub.myshopify.com/account',
        [
          occurrence('input[value="shopper@example.com"]'),
          occurrence('a[href="/account/reset/4821?key=reset-key"]'),
          occurrence('#jane\\.doe\\@example\\.com > img'),
          occurrence('form[action="/cart?id_token=eyJhbGciOiJIUzI1NiJ9"] >>> img[alt="Jane Doe"]'),
        ],
        finalUrl,
      ),
    );

    const rows = await db.owner<{ page_url: string; target: string; whole: string }[]>`
      select page_url, target, row_to_json(o)::text as whole
        from finding_occurrences o where scan_id = ${f.scanId} order by target collate "C"`;
    expect(rows.map((r) => r.target)).toEqual([
      '#[email] > img',
      'a[href]',
      'form[action] >>> img[alt]',
      'input[value]',
    ]);
    for (const row of rows) {
      expect(row.page_url).toBe('https://scrub.myshopify.com/account/[email]/orders');
      for (const secret of SECRETS) expect(row.whole).not.toContain(secret);
    }
  });

  it('fingerprints the scrubbed selector: values never reach a hash and one element merges', async () => {
    const f = await seed(db.owner, 'https://merge.myshopify.com', { pages: 2 });
    await recordPage(
      worker,
      f,
      page('https://merge.myshopify.com/a', [occurrence('a[href="/products/scarf"]')]),
    );
    await recordPage(
      worker,
      f,
      page('https://merge.myshopify.com/b', [occurrence('a[href="/products/gloves?utm=x"]')]),
    );
    const found = await db.owner<{ occurrence_count: number; fingerprint: Buffer }[]>`
      select occurrence_count, fingerprint from findings where site_id = ${f.siteId}`;
    expect(found).toHaveLength(1);
    expect(found[0]?.occurrence_count).toBe(2);
    expect(Buffer.from(found[0]?.fingerprint ?? []).toString('hex')).toBe(
      Buffer.from(fingerprint('image-alt', 'a[href]', SECTION)).toString('hex'),
    );
  });

  it('drops characters PostgreSQL text cannot hold instead of failing the page', async () => {
    const f = await seed(db.owner, 'https://nul.myshopify.com', { pages: 1 });
    const scan = page(
      'https://nul.myshopify.com/',
      [occurrence('img\u0000[alt="x\u0000"]')],
      'https://nul.myshopify.com/a\u0000b',
    );
    await expect(recordPage(worker, f, scan)).resolves.toMatchObject({ recorded: true });
    const [row] = await db.owner<{ page_url: string; target: string }[]>`
      select page_url, target from finding_occurrences where scan_id = ${f.scanId}`;
    expect(row).toEqual({ page_url: 'https://nul.myshopify.com/ab', target: 'img[alt]' });
  });
});
