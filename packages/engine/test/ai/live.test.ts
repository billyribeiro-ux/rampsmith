/**
 * The live check for `ai.alt_text@1` (LAUNCH.md section E): a real Claude call on a real image
 * through the engine's own path. It runs when `ANTHROPIC_API_KEY` is set and otherwise skips
 * with a notice naming the input (LAUNCH.md section C, row 5); it never passes silently. The
 * substitute that passes now is `alt-text.test.ts`, which replays responses in the documented
 * Messages API shape.
 *
 *   ANTHROPIC_API_KEY=… DATABASE_URL=… pnpm --filter @rampsmith/engine exec vitest run test/ai/live.test.ts
 */
import process from 'node:process';
import { createAnthropicTransport } from '@rampsmith/ai';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { altTextHandler } from '../../src/jobs/alt-text.ts';
import { freshDatabase, seed, type TestDatabase } from '../db.ts';
import { createHash } from 'node:crypto';
import { uuidv7 } from '@rampsmith/queue';

const key = process.env['ANTHROPIC_API_KEY'] ?? '';
const live = key.trim() !== '';
const NOTICE = 'needs ANTHROPIC_API_KEY (LAUNCH.md section C, row 5)';

if (!live) {
  const annotation =
    process.env['GITHUB_ACTIONS'] === 'true' ? '::notice title=Alt-text live check skipped::' : '';
  process.stderr.write(`${annotation}alt-text live check skipped: ${NOTICE}\n`);
}

describe.skipIf(!live)(`live alt-text job (${NOTICE})`, () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('drafts alt text for a generated image and stores it as a proposed fix', async () => {
    const f = await seed(db.owner, 'https://live.myshopify.com');
    const image = await sharp({
      create: { width: 800, height: 800, channels: 3, background: '#d2691e' },
    })
      .jpeg()
      .toBuffer();
    const findingId = uuidv7();
    const inputId = uuidv7();
    const gid = 'gid://shopify/MediaImage/1';
    await db.owner`
      insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                            first_seen_scan, last_seen_scan, occurrence_count, origin)
      values (${findingId}, ${f.tenantId}, ${f.siteId}, ${createHash('sha256').update(findingId).digest()},
              'image-alt-missing', ${['1.1.1']}, 'critical', 'open', ${f.scanId}, ${f.scanId}, 1, 'data')`;
    await db.owner`
      insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
      values (${inputId}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, 'products', 0, ${db.owner.json({
        products: [
          {
            title: 'Terracotta plant pot',
            productType: 'Planters',
            media: [
              { id: gid, alt: null, image: { url: 'https://cdn.shopify.com/s/files/1/live.jpg' } },
            ],
          },
        ],
      })})`;
    const run = altTextHandler({
      sql: db.as('rampsmith_worker'),
      egress: { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'x'.repeat(48) },
      transport: createAnthropicTransport({ apiKey: key }),
      fetchImage: () => Promise.resolve(image),
    });
    await run({
      payloadSchema: 'ai.alt_text@1',
      tenantId: f.tenantId,
      payload: { site_id: f.siteId, finding_id: findingId, input_id: inputId, resource_gid: gid },
    });
    const calls =
      await db.owner`select model, outcome from ai_calls where tenant_id = ${f.tenantId}`;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.['model']).toBe('claude-haiku-5-5');
  });
});
