import { describe, expect, it } from 'vitest';
import { allFixes, findingsKey, openFindingsFor } from './export.server.ts';
import type { FindingSummary, Overview } from './types.ts';
import { tooLarge, type Upstream } from './upstream.server.ts';

const finding = (n: number): FindingSummary =>
  ({ id: `f${String(n)}`, rule_id: 'image-alt', status: 'open' }) as unknown as FindingSummary;

/** Each test uses its own shop: the list is cached per shop for the life of the module. */
function overview(over: Partial<Overview> = {}, domain = 'demo.myshopify.com'): Overview {
  return {
    shop: { domain, name: 'Demo' },
    latest_scan: { id: 's1', finished_at: '2026-10-20T10:00:00Z' },
    open_by_impact: { critical: 1, serious: 2, moderate: 0, minor: 0 },
    fixes_applied: 1,
    fixes_awaiting_approval: 2,
    ...over,
  } as unknown as Overview;
}

/** An upstream that serves `total` findings in pages and counts what it was asked. */
function fake(total: number, status = 200) {
  const calls: string[] = [];
  let cancelled = 0;
  const upstream: Upstream = {
    call: (path) => {
      calls.push(path);
      const params = new URLSearchParams(path.split('?')[1]);
      const limit = Number(params.get('limit'));
      const start = Number(params.get('cursor') ?? '0');
      const end = Math.min(total, start + limit);
      const items = Array.from({ length: Math.max(0, end - start) }, (_, i) => finding(start + i));
      const body = JSON.stringify({ items, next_cursor: end < total ? String(end) : null });
      const response = new Response(status === 200 ? body : 'nope', { status });
      const cancel = response.body?.cancel.bind(response.body);
      if (response.body !== null && cancel !== undefined) {
        response.body.cancel = (reason?: unknown) => {
          cancelled += 1;
          return cancel(reason);
        };
      }
      return Promise.resolve(response);
    },
  };
  return { upstream, calls, cancelled: () => cancelled };
}

describe('the statement preview loads open findings once per state of the shop (audit L6)', () => {
  it('asks for pages of 100 and reuses the list while the overview is unchanged', async () => {
    const { upstream, calls } = fake(250);
    const shop = 'once.myshopify.com';
    const first = await openFindingsFor(upstream, overview({}, shop), 1_000);
    expect(first).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.includes('limit=100'))).toBe(true);

    // Ten more previews while the merchant types: no further request.
    for (let i = 0; i < 10; i += 1) {
      expect(await openFindingsFor(upstream, overview({}, shop), 2_000 + i)).toBe(first);
    }
    expect(calls).toHaveLength(3);
  });

  it('loads again when a scan, a fix or the clock moved things on', async () => {
    const { upstream, calls } = fake(5);
    const shop = 'moves.myshopify.com';
    await openFindingsFor(upstream, overview({}, shop), 10_000);
    await openFindingsFor(upstream, overview({ fixes_applied: 2 }, shop), 10_001);
    await openFindingsFor(upstream, overview({ latest_scan: null }, shop), 10_002);
    expect(calls).toHaveLength(3);
    await openFindingsFor(upstream, overview({}, shop), 10_000 + 6 * 60 * 1000);
    expect(calls).toHaveLength(4);
  });

  it("never serves one shop's list to another", async () => {
    const mine = fake(2);
    const theirs = fake(3);
    const a = await openFindingsFor(mine.upstream, overview({}, 'mine.myshopify.com'), 50_000);
    const b = await openFindingsFor(theirs.upstream, overview({}, 'theirs.myshopify.com'), 50_001);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
    expect(findingsKey(overview({}, 'mine.myshopify.com'))).not.toBe(
      findingsKey(overview({}, 'theirs.myshopify.com')),
    );
  });

  it('does not cache a failure, and closes the response it will not read (L4)', async () => {
    const failing = fake(5, 500);
    expect(
      await openFindingsFor(
        failing.upstream,
        overview({ fixes_applied: 9 }, 'fails.myshopify.com'),
        90_000,
      ),
    ).toBe(undefined);
    expect(failing.cancelled()).toBe(1);
    expect(await allFixes(failing.upstream)).toBeUndefined();
    const ok = fake(1);
    expect(
      await openFindingsFor(
        ok.upstream,
        overview({ fixes_applied: 9 }, 'fails.myshopify.com'),
        90_001,
      ),
    ).toHaveLength(1);
  });
});

describe('the size check counts bytes (audit L6)', () => {
  it('sees a body of multi-byte characters that its length undercounts', () => {
    const text = 'é'.repeat(40_000);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(tooLarge(text, 64 * 1024)).toBe(true);
    expect(tooLarge('é'.repeat(30_000), 64 * 1024)).toBe(false);
    expect(tooLarge('a'.repeat(64 * 1024), 64 * 1024)).toBe(false);
    expect(tooLarge('a'.repeat(64 * 1024 + 1), 64 * 1024)).toBe(true);
  });
});
