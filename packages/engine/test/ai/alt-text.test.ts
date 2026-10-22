import { createHash, randomBytes } from 'node:crypto';
import type { AiTransport, TransportResponse } from '@rampsmith/ai';
import { JobFailure, uuidv7 } from '@rampsmith/queue';
import sharp from 'sharp';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { altTextHandler, DEFAULT_BUDGET_MICRO_USD } from '../../src/jobs/alt-text.ts';
import type { JobInput } from '../../src/jobs/payload.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from '../db.ts';

/** The Messages API response shape the SDK returns (recorded shape, ADR-090). */
function reply(output: unknown, model = 'claude-haiku-5-5', stop = 'end_turn') {
  return {
    id: 'msg_01FakeFakeFakeFakeFakeFake',
    container: null,
    content: [{ type: 'text', text: JSON.stringify(output), citations: null }],
    diagnostics: null,
    model,
    role: 'assistant',
    stop_details: null,
    stop_reason: stop,
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: 'global',
      input_tokens: 1700,
      output_tokens: 60,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: 'standard',
    },
  } as unknown as TransportResponse['message'];
}

const DRAFT = {
  alt: 'Peach-orange dahlia in full bloom against dark green foliage',
  decorative: false,
  contains_text: false,
  instruction_like_text: false,
  language: 'en',
  confidence: 0.9,
};

class Scripted implements AiTransport {
  readonly requests: Parameters<AiTransport['createMessage']>[0][] = [];
  readonly #script: (TransportResponse['message'] | Error)[];
  constructor(script: (TransportResponse['message'] | Error)[]) {
    this.#script = script;
  }
  createMessage(params: Parameters<AiTransport['createMessage']>[0]): Promise<TransportResponse> {
    this.requests.push(params);
    const next = this.#script.shift();
    if (next === undefined) return Promise.reject(new Error('script exhausted'));
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve({ message: next, requestId: 'req_test' });
  }
  createBatch(): never {
    throw new Error('not used');
  }
  retrieveBatch(): never {
    throw new Error('not used');
  }
  batchResults(): never {
    throw new Error('not used');
  }
  deleteBatch(): never {
    throw new Error('not used');
  }
}

let db: TestDatabase;
let worker: postgres.Sql;
let image: Buffer;
const GID = 'gid://shopify/MediaImage/9001';
const egress = { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'x'.repeat(48) };

beforeAll(async () => {
  db = await freshDatabase();
  worker = db.as('rampsmith_worker');
  image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#e07b39' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'Jane Doe' } })
    .toBuffer();
});
afterAll(async () => {
  await db.drop();
});

interface World extends Fixture {
  readonly findingId: string;
  readonly inputId: string;
}

/** A tenant with an open alt-text finding and the store data `ctl` would have read. */
async function world(settings: Record<string, number> = {}): Promise<World> {
  const f = await seed(db.owner, `https://${randomBytes(4).toString('hex')}.myshopify.com`);
  await db.owner`update sites set settings = ${db.owner.json(settings)} where id = ${f.siteId}`;
  const findingId = uuidv7();
  await db.owner`
    insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                          first_seen_scan, last_seen_scan, occurrence_count, origin)
    values (${findingId}, ${f.tenantId}, ${f.siteId},
            ${createHash('sha256').update(findingId).digest()}, 'image-alt-missing', ${['1.1.1']},
            'critical', 'open', ${f.scanId}, ${f.scanId}, 1, 'data')`;
  const inputId = uuidv7();
  const products = {
    products: [
      {
        id: 'gid://shopify/Product/1',
        title: 'Dahlia seed packet',
        productType: 'Seeds',
        media: [{ id: GID, alt: null, image: { url: 'https://cdn.shopify.com/s/files/1/a.jpg' } }],
      },
    ],
  };
  await db.owner`
    insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
    values (${inputId}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, 'products', 0,
            ${db.owner.json(products)}),
           (${uuidv7()}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, 'shop', 0,
            ${db.owner.json({ primaryLocale: 'en' })})`;
  return { ...f, findingId, inputId };
}

function jobFor(w: World, tenantId: string = w.tenantId, gid: string = GID): JobInput {
  return {
    payloadSchema: 'ai.alt_text@1',
    tenantId,
    payload: { site_id: w.siteId, finding_id: w.findingId, input_id: w.inputId, resource_gid: gid },
  };
}

function handler(transport: AiTransport, fetched: string[] = []) {
  return altTextHandler({
    sql: worker,
    egress,
    transport,
    fetchImage: (url) => {
      fetched.push(url);
      return Promise.resolve(image);
    },
  });
}

async function failure(run: Promise<unknown>): Promise<JobFailure> {
  const e: unknown = await run.catch((x: unknown) => x);
  if (!(e instanceof JobFailure)) throw new Error('expected a JobFailure');
  return e;
}

describe('ai.alt_text@1 (PLAN §13, ADR-090)', () => {
  it('stores the draft as a proposed fix with its diff, snapshot, model and prompt version', async () => {
    const w = await world();
    const transport = new Scripted([reply(DRAFT)]);
    const fetched: string[] = [];
    await handler(transport, fetched)(jobFor(w));

    expect(fetched).toEqual(['https://cdn.shopify.com/s/files/1/a.jpg']);
    const fixes = await db.owner<
      {
        id: string;
        status: string;
        origin: string;
        kind: string;
        channel: string;
        model: string;
        prompt_version: string;
        confidence: string;
        diff: Record<string, unknown>;
        edited: boolean;
      }[]
    >`select f.* from fixes f join fix_findings ff on ff.fix_id = f.id where ff.finding_id = ${w.findingId}`;
    expect(fixes).toHaveLength(1);
    const fix = fixes[0];
    expect(fix).toMatchObject({
      status: 'proposed',
      origin: 'ai',
      kind: 'data',
      channel: 'admin_api',
      model: 'claude-haiku-5-5',
      prompt_version: 'alt-text@2',
      edited: false,
    });
    expect(Number(fix?.confidence)).toBeCloseTo(0.9);
    expect(fix?.diff).toEqual({
      type: 'alt_text',
      resource_gid: GID,
      field: 'alt',
      before: null,
      after: DRAFT.alt,
      language: 'en',
      contains_text: false,
      escalated: false,
    });
    const snaps = await db.owner<{ before_value: unknown; after_value: unknown; field: string }[]>`
      select field, before_value, after_value from data_fix_snapshots where fix_id = ${fix?.id ?? ''}`;
    const snap = snaps[0];
    expect(snap).toEqual({ field: 'alt', before_value: null, after_value: DRAFT.alt });

    // The model got a resized image without metadata, and Haiku's answer settled the budget.
    const sent = JSON.stringify(transport.requests[0]);
    expect(sent).not.toContain('Jane Doe');
    const content = transport.requests[0]?.messages[0]?.content;
    const block = Array.isArray(content) ? content.find((b) => b.type === 'image') : undefined;
    const data = block?.type === 'image' && block.source.type === 'base64' ? block.source.data : '';
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1008);
    expect(meta.exif).toBeUndefined();

    const calls = await db.owner<{ model: string; outcome: string; mode: string; cost: string }[]>`
      select model, outcome, mode, cost_micro_usd::text as cost from ai_calls
       where tenant_id = ${w.tenantId}`;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'claude-haiku-5-5', outcome: 'ok', mode: 'sync' });
    const [budget] = await db.owner<{ spent: string; reserved: string }[]>`
      select spent_micro_usd::text as spent, reserved_micro_usd::text as reserved
        from ai_budgets where tenant_id = ${w.tenantId}`;
    expect(Number(budget?.reserved)).toBe(0);
    expect(Number(budget?.spent)).toBe(Number(calls[0]?.cost));
    // The call record holds metadata only: nothing of the prompt, image or answer.
    const [row] = await db.owner`select * from ai_calls where tenant_id = ${w.tenantId}`;
    expect(JSON.stringify(row)).not.toContain('dahlia');
  });

  it('keeps the existing alt text as the before value when the image already has some', async () => {
    const w = await world();
    await db.owner`
      update scan_inputs set payload = jsonb_set(payload, '{products,0,media,0,alt}', '"old text"')
       where id = ${w.inputId}`;
    await handler(new Scripted([reply(DRAFT)]))(jobFor(w));
    const [fix] = await db.owner<{ diff: { before: string } }[]>`
      select f.diff from fixes f join fix_findings ff on ff.fix_id = f.id
       where ff.finding_id = ${w.findingId}`;
    expect(fix?.diff.before).toBe('old text');
  });

  it('escalates an image with embedded text to Sonnet and records both calls', async () => {
    const w = await world();
    const transport = new Scripted([
      reply({ ...DRAFT, contains_text: true, alt: 'Size chart' }),
      reply(
        { ...DRAFT, alt: 'Size chart listing sleeve lengths from S to XL' },
        'claude-sonnet-5-5',
      ),
    ]);
    await handler(transport)(jobFor(w));
    expect(transport.requests.map((r) => r.model)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
    ]);
    const [fix] = await db.owner<{ model: string; diff: { escalated: boolean; after: string } }[]>`
      select f.model, f.diff from fixes f join fix_findings ff on ff.fix_id = f.id
       where ff.finding_id = ${w.findingId}`;
    expect(fix?.model).toBe('claude-sonnet-5-5');
    expect(fix?.diff.escalated).toBe(true);
    const calls = await db.owner`select 1 from ai_calls where tenant_id = ${w.tenantId}`;
    expect(calls).toHaveLength(2);
  });

  it('is idempotent: a second run (a retry or a rescan) makes no call and no second fix', async () => {
    const w = await world();
    const transport = new Scripted([reply(DRAFT)]);
    const run = handler(transport);
    await run(jobFor(w));
    await run(jobFor(w));
    expect(transport.requests).toHaveLength(1);
    const fixes = await db.owner`select 1 from fix_findings where finding_id = ${w.findingId}`;
    expect(fixes).toHaveLength(1);
  });

  it('does not re-draft a finding whose draft the merchant rejected', async () => {
    const w = await world();
    const transport = new Scripted([reply(DRAFT)]);
    const run = handler(transport);
    await run(jobFor(w));
    await db.owner`update fixes set status = 'rejected' where tenant_id = ${w.tenantId}`;
    await run(jobFor(w));
    expect(transport.requests).toHaveLength(1);
  });

  it('serialises two concurrent drafts of one finding into one fix', async () => {
    const w = await world();
    const transport = new Scripted([reply(DRAFT), reply(DRAFT)]);
    const run = handler(transport);
    await Promise.all([run(jobFor(w)), run(jobFor(w))]);
    const fixes = await db.owner`select 1 from fix_findings where finding_id = ${w.findingId}`;
    expect(fixes).toHaveLength(1);
  });

  it('stores nothing when the draft fails the PLAN §13 checks, so no bad text reaches the queue', async () => {
    const w = await world();
    // Both passes (Haiku, then Sonnet) start with "Image of": a draft the checks refuse.
    const bad = { ...DRAFT, alt: 'Image of a dahlia' };
    await handler(new Scripted([reply(bad), reply(bad, 'claude-sonnet-5-5')]))(jobFor(w));
    expect(
      await db.owner`select 1 from fix_findings where finding_id = ${w.findingId}`,
    ).toHaveLength(0);
    // Both calls were still recorded and paid for.
    expect(await db.owner`select 1 from ai_calls where tenant_id = ${w.tenantId}`).toHaveLength(2);
  });

  it('stops at the monthly budget: no call, a permanent ai_budget_exhausted, nothing charged', async () => {
    const w = await world({ ai_budget_micro_usd: 1 });
    const transport = new Scripted([reply(DRAFT)]);
    const e = await failure(handler(transport)(jobFor(w)));
    expect(e.failure).toMatchObject({ kind: 'permanent', error: { code: 'ai_budget_exhausted' } });
    expect(transport.requests).toHaveLength(0);
    expect(await db.owner`select 1 from fixes where tenant_id = ${w.tenantId}`).toHaveLength(0);
    expect(DEFAULT_BUDGET_MICRO_USD).toBe(500_000);
  });

  it('records a refusal as a permanent failure and never as a draft', async () => {
    const w = await world();
    const e = await failure(
      handler(new Scripted([reply({}, 'claude-haiku-5-5', 'refusal')]))(jobFor(w)),
    );
    expect(e.failure).toMatchObject({ kind: 'permanent', error: { code: 'ai_refused' } });
    expect(await db.owner`select 1 from fixes where tenant_id = ${w.tenantId}`).toHaveLength(0);
    const [call] = await db.owner<{ outcome: string }[]>`
      select outcome from ai_calls where tenant_id = ${w.tenantId}`;
    expect(call?.outcome).toBe('refused');
  });

  it("refuses another tenant's finding without reading it", async () => {
    const mine = await world();
    const theirs = await world();
    const transport = new Scripted([reply(DRAFT)]);
    // tenant B's job names tenant A's ids: row-level security hides every one of them.
    const e = await failure(handler(transport)(jobFor(mine, theirs.tenantId)));
    expect(e.failure.error.code).toBe('site_not_found');
    expect(transport.requests).toHaveLength(0);
  });

  it('fails permanently for an image the stored data does not hold, naming no value', async () => {
    const w = await world();
    const e = await failure(
      handler(new Scripted([]))(jobFor(w, w.tenantId, 'gid://shopify/MediaImage/1')),
    );
    expect(e.failure.error.code).toBe('image_not_found');
    expect(e.failure.error.message).not.toContain('MediaImage/1');
  });

  it('turns an image outside a Shopify media host into a permanent failure', async () => {
    const w = await world();
    await db.owner`
      update scan_inputs
         set payload = jsonb_set(payload, '{products,0,media,0,image,url}', '"https://evil.example/a.jpg"')
       where id = ${w.inputId}`;
    const run = altTextHandler({ sql: worker, egress, transport: new Scripted([]) });
    const e = await failure(run(jobFor(w)));
    expect(e.failure).toMatchObject({ kind: 'permanent', error: { code: 'image_url_off_host' } });
  });

  it('says what is missing when ANTHROPIC_API_KEY is not set (LAUNCH.md section C, row 5)', async () => {
    const w = await world();
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const run = altTextHandler({ sql: worker, egress, fetchImage: () => Promise.resolve(image) });
      const e = await failure(run(jobFor(w)));
      expect(e.failure).toMatchObject({ kind: 'permanent', error: { code: 'ai_not_configured' } });
      expect(e.failure.error.message).toContain('row 5');
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('validates the payload against the generated schema', async () => {
    const w = await world();
    const bad: JobInput = { ...jobFor(w), payload: { site_id: w.siteId } };
    const e = await failure(handler(new Scripted([]))(bad));
    expect(e.failure.error.code).toBe('payload_invalid');
  });
});
