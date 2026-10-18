import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Occurrence, PageScan } from '../src/scan-page.ts';
import { recordPage, withTenant } from '../src/store.ts';
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

const imageAlt = (target: string): Occurrence => ({
  ruleId: 'image-alt',
  impact: 'critical',
  criteria: ['1.1.1'],
  help: 'Images must have alternative text',
  target,
  html: '<img src="a.png">',
  section: 'shopify-section-template--1234__main',
});

function page(url: string, violations: Occurrence[]): PageScan {
  return {
    url,
    finalUrl: url,
    status: 200,
    blocked: undefined,
    violations,
    incomplete: [],
    durationMs: 1234.5,
  };
}

describe('recordPage', () => {
  it('merges one template failure across pages into one finding with every occurrence', async () => {
    const f = await seed(db.owner, 'https://demo.myshopify.com', { pages: 2 });
    const first = await recordPage(
      worker,
      f,
      page('https://demo.myshopify.com/products/a', [
        imageAlt('div:nth-child(2) > img'),
        imageAlt('div:nth-child(5) > img'),
      ]),
    );
    expect(first).toEqual({ recorded: true, findings: 1, occurrences: 2 });
    const second = await recordPage(
      worker,
      f,
      page('https://demo.myshopify.com/products/b', [imageAlt('div:nth-child(9) > img')]),
    );
    expect(second.recorded).toBe(true);

    const findings = await db.owner<
      { rule_id: string; occurrence_count: number; criteria: string[] }[]
    >`
      select rule_id, occurrence_count, criteria from findings where site_id = ${f.siteId}`;
    expect(findings).toEqual([{ rule_id: 'image-alt', occurrence_count: 3, criteria: ['1.1.1'] }]);
    const [scan] = await db.owner<{ pages_done: number; status: string; finished: boolean }[]>`
      select pages_done, status, finished_at is not null as finished from scans where id = ${f.scanId}`;
    expect(scan).toEqual({ pages_done: 2, status: 'succeeded', finished: true });
    const [row] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from finding_occurrences where scan_id = ${f.scanId}`;
    expect(row?.count).toBe(3);
  });

  it('records a page once, however often its job runs', async () => {
    const f = await seed(db.owner, 'https://twice.myshopify.com', { pages: 3 });
    const scan = page('https://twice.myshopify.com/', [imageAlt('img')]);
    expect((await recordPage(worker, f, scan)).recorded).toBe(true);
    expect(await recordPage(worker, f, scan)).toEqual({
      recorded: false,
      findings: 0,
      occurrences: 0,
    });
    const [row] = await db.owner<{ pages_done: number; occurrence_count: number }[]>`
      select s.pages_done, f.occurrence_count from scans s join findings f on f.last_seen_scan = s.id
       where s.id = ${f.scanId}`;
    expect(row).toEqual({ pages_done: 1, occurrence_count: 1 });
  });

  it('records a blocked page without findings', async () => {
    const f = await seed(db.owner, 'https://walled.myshopify.com', { pages: 1 });
    const blocked = {
      ...page('https://walled.myshopify.com/', []),
      status: 403,
      blocked: 'cloudflare' as const,
    };
    expect(await recordPage(worker, f, blocked)).toEqual({
      recorded: true,
      findings: 0,
      occurrences: 0,
    });
    const [row] = await db.owner<{ blocked_reason: string; http_status: number }[]>`
      select blocked_reason, http_status from scan_pages where scan_id = ${f.scanId}`;
    expect(row).toEqual({ blocked_reason: 'cloudflare', http_status: 403 });
  });

  it("cannot write to or read another tenant's scan", async () => {
    const mine = await seed(db.owner, 'https://mine.myshopify.com');
    const theirs = await seed(db.owner, 'https://theirs.myshopify.com');
    // My tenant, their site and scan: the composite keys and row-level security refuse it.
    await expect(
      recordPage(
        worker,
        { ...theirs, tenantId: mine.tenantId },
        page('https://theirs.myshopify.com/', [imageAlt('img')]),
      ),
    ).rejects.toThrow();
    await recordPage(worker, theirs, page('https://theirs.myshopify.com/', [imageAlt('img')]));
    const visible = await withTenant(
      worker,
      mine.tenantId,
      (tx) =>
        tx<{ n: number }[]>`
        select (select count(*) from findings)::int + (select count(*) from scan_pages)::int
             + (select count(*) from finding_occurrences)::int as n
          from (select 1) x`,
    );
    expect(visible[0]?.n).toBe(0);
  });
});
