/**
 * Regression detection against PostgreSQL (ADR-310, ADR-311): the comparison of a scheduled scan
 * with the one before it, by stable finding fingerprint.
 */
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/store.ts';
import { MAX_ITEMS, passRate, recordRegression } from '../src/pipeline/regressions.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from './db.ts';

let db: TestDatabase;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  sql = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

let clock = Date.parse('2026-10-01T00:00:00Z');

/** Adds a finished scan of the site. Scans are created one hour apart, in call order. */
async function scan(
  f: Fixture,
  options: {
    trigger?: string;
    status?: string;
    checks?: [run: number, passed: number];
  } = {},
): Promise<string> {
  const id = uuidv7();
  const [run, passed] = options.checks ?? [100, 90];
  clock += 3_600_000;
  await db.owner`
    insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned,
                       checks_run, checks_passed, created_at, finalized_at)
    values (${id}, ${f.tenantId}, ${f.siteId}, ${options.trigger ?? 'scheduled'},
            ${options.status ?? 'succeeded'}, 'axe-4.14.0', 1, ${run}, ${passed},
            ${new Date(clock)}, ${new Date(clock)})`;
  return id;
}

async function finding(
  f: Fixture,
  firstSeen: string,
  options: { status?: string; impact?: string; bestPractice?: boolean; rule?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await db.owner`
    insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                          first_seen_scan, last_seen_scan, occurrence_count, best_practice)
    values (${id}, ${f.tenantId}, ${f.siteId}, ${randomBytes(32)}, ${options.rule ?? 'image-alt'},
            ${db.owner.array(['1.1.1'])}, ${options.impact ?? 'serious'},
            ${options.status ?? 'open'}, ${firstSeen}, ${firstSeen}, 1,
            ${options.bestPractice ?? false})`;
  return id;
}

async function sees(f: Fixture, scanId: string, findingId: string): Promise<void> {
  await db.owner`
    insert into finding_occurrences (finding_id, scan_id, tenant_id, page_url, page_state, target,
                                     html_excerpt, captured_at)
    values (${findingId}, ${scanId}, ${f.tenantId}, 'https://shop.example/', 'default', 'img',
            '<img>', now())`;
}

const run = (f: Fixture, scanId: string, over: Partial<{ trigger: string; status: string }> = {}) =>
  withTenant(sql, f.tenantId, (tx) =>
    recordRegression(tx, {
      tenantId: f.tenantId,
      siteId: f.siteId,
      scanId,
      trigger: over.trigger ?? 'scheduled',
      status: over.status ?? 'succeeded',
    }),
  );

describe('recordRegression', () => {
  it('records the first scan with nothing to compare, once', async () => {
    const f = await seed(db.owner, 'https://shop.example');
    const first = await scan(f);
    const record = await run(f, first);
    expect(record).toMatchObject({ previousScanId: null, newCount: 0, reappearedCount: 0 });
    expect(await run(f, first)).toBeNull();
    const rows = await db.owner`select * from regressions where scan_id = ${first}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ alert_state: 'not_applicable', previous_scan_id: null });
  });

  it('finds new findings and findings that came back, by fingerprint', async () => {
    const f = await seed(db.owner, 'https://shop.example');
    const s1 = await scan(f, { checks: [100, 90] });
    const a = await finding(f, s1);
    const b = await finding(f, s1, { impact: 'critical' });
    await sees(f, s1, a);
    await sees(f, s1, b);
    await run(f, s1);

    // Scan 2: B is gone (fixed), A stays. Nothing regressed.
    const s2 = await scan(f, { checks: [100, 95] });
    await db.owner`update findings set status = 'fixed' where id = ${b}`;
    await sees(f, s2, a);
    const second = await run(f, s2);
    expect(second).toMatchObject({ previousScanId: s1, newCount: 0, reappearedCount: 0 });

    // Scan 3: B is back, C is new; a best practice, a finding to review and an accepted risk
    // appear too and are not regressions.
    const s3 = await scan(f, { checks: [100, 80] });
    await db.owner`update findings set status = 'open' where id = ${b}`;
    const c = await finding(f, s3, { impact: 'moderate', rule: 'color-contrast' });
    const practice = await finding(f, s3, { bestPractice: true });
    const review = await finding(f, s3, { status: 'needs_review' });
    const accepted = await finding(f, s3, { status: 'accepted_risk' });
    for (const id of [a, b, c, practice, review, accepted]) await sees(f, s3, id);
    const third = await run(f, s3);
    expect(third).toMatchObject({ previousScanId: s2, newCount: 1, reappearedCount: 1 });
    // Most severe first: the critical finding that came back, then the new moderate one.
    expect(third?.items.map((i) => [i.findingId, i.kind, i.impact])).toEqual([
      [b, 'reappeared', 'critical'],
      [c, 'new', 'moderate'],
    ]);
    const [row] = await db.owner`select * from regressions where scan_id = ${s3}`;
    expect(row).toMatchObject({
      new_count: 1,
      reappeared_count: 1,
      // A, B, C, the review item and the accepted risk; the best practice is left out.
      findings_seen: 5,
      previous_findings_seen: 1,
    });
    expect(Number(row?.['pass_rate'])).toBe(80);
    expect(Number(row?.['previous_pass_rate'])).toBe(95);
  });

  it('compares with the previous completed scan, skipping failed and verification scans', async () => {
    const f = await seed(db.owner, 'https://shop.example');
    const s1 = await scan(f);
    const a = await finding(f, s1);
    await sees(f, s1, a);
    await scan(f, { status: 'failed' });
    await scan(f, { trigger: 'verify' });
    await scan(f, { trigger: 'free' });
    const s5 = await scan(f);
    await sees(f, s5, a);
    const b = await finding(f, s5);
    await sees(f, s5, b);
    const record = await run(f, s5);
    expect(record).toMatchObject({ previousScanId: s1, newCount: 1, reappearedCount: 0 });
  });

  it('evaluates only finished scheduled scans', async () => {
    const f = await seed(db.owner, 'https://shop.example');
    const manual = await scan(f, { trigger: 'manual' });
    expect(await run(f, manual, { trigger: 'manual' })).toBeNull();
    const failed = await scan(f, { status: 'failed' });
    expect(await run(f, failed, { status: 'failed' })).toBeNull();
    const rows = await db.owner`select 1 from regressions where tenant_id = ${f.tenantId}`;
    expect(rows).toHaveLength(0);
  });

  it('lists at most MAX_ITEMS findings and counts all of them', async () => {
    const f = await seed(db.owner, 'https://shop.example');
    const s1 = await scan(f);
    await run(f, s1);
    const s2 = await scan(f);
    for (let i = 0; i < MAX_ITEMS + 5; i += 1) await sees(f, s2, await finding(f, s2));
    const record = await run(f, s2);
    expect(record?.newCount).toBe(MAX_ITEMS + 5);
    expect(record?.items).toHaveLength(MAX_ITEMS);
    const [row] =
      await db.owner`select jsonb_array_length(items) as n from regressions where scan_id = ${s2}`;
    expect(row?.['n']).toBe(MAX_ITEMS);
  });

  it('never reads another tenant: its rows are invisible to the compared scan', async () => {
    const mine = await seed(db.owner, 'https://shop-one.example');
    const theirs = await seed(db.owner, 'https://shop-two.example');
    const s1 = await scan(mine);
    await run(mine, s1);
    const t1 = await scan(theirs);
    const stranger = await finding(theirs, t1);
    await sees(theirs, t1, stranger);
    const s2 = await scan(mine);
    const record = await run(mine, s2);
    expect(record).toMatchObject({ newCount: 0, reappearedCount: 0 });
  });
});

describe('passRate', () => {
  it('is a percentage with two decimals, or null without checks', () => {
    expect(passRate(0, 0)).toBeNull();
    expect(passRate(3, 1)).toBe(33.33);
    expect(passRate(10, 12)).toBe(100);
  });
});
