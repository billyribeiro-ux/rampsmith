import { InternalServerError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  chunkBatchItems,
  collectBatch,
  pollBatch,
  retireBatch,
  submitBatch,
  type BatchItem,
} from '../src/batch.ts';
import { worstCaseCostMicroUsd } from '../src/cost.ts';
import { prepareAltText, type AltTextDraft, type AltTextInput } from '../src/tasks/alt-text.ts';
import { FakeTransport, TENANT, TINY_JPEG, message, testDeps } from './fakes.ts';

const input: AltTextInput = {
  image: { mediaType: 'image/jpeg', base64: TINY_JPEG, width: 28, height: 28 },
  productTitle: 'Alpine Wool Beanie',
  productType: 'Hats',
  primaryLocale: 'en',
};
const draft = {
  alt: 'Navy blue ribbed wool beanie with a folded cuff',
  decorative: false,
  contains_text: false,
  instruction_like_text: false,
  language: 'en',
  confidence: 0.9,
};

const item = (customId: string, tenantId = TENANT): BatchItem<AltTextDraft> => ({
  customId,
  tenantId,
  call: prepareAltText(input, { tenantId }),
});

describe('submitBatch', () => {
  it('reserves each item at batch prices and submits one batch', async () => {
    const transport = new FakeTransport();
    const deps = testDeps(transport);
    const { ticket, refused } = await submitBatch(deps, [item('a1'), item('a2')]);
    expect(refused).toEqual([]);
    expect(ticket?.batchId).toBe('msgbatch_1');
    expect(ticket?.items.map((i) => [i.customId, i.task, i.model, i.promptVersion])).toEqual([
      ['a1', 'alt_text', 'claude-haiku-5-5', 'alt-text@1'],
      ['a2', 'alt_text', 'claude-haiku-5-5', 'alt-text@1'],
    ]);
    const reserved = ticket?.items.reduce((s, i) => s + i.reservedMicroUsd, 0) ?? 0;
    expect(deps.ledger.usage(TENANT, '2026-10').reservedMicroUsd).toBe(reserved);
    const sent = transport.batches.get('msgbatch_1')?.requests ?? [];
    expect(sent.map((r) => r.custom_id)).toEqual(['a1', 'a2']);
    expect(JSON.stringify(ticket)).not.toContain('Alpine');
  });

  it('refuses items the budget cannot cover and sends the rest', async () => {
    const transport = new FakeTransport();
    const one = item('only').call;
    const worst = worstCaseCostMicroUsd('claude-haiku-5-5', 'batch', one.estimatedInputTokens, 400);
    const deps = testDeps(transport, { limitMicroUsd: worst + 1 });
    const { ticket, refused } = await submitBatch(deps, [item('b1'), item('b2'), item('b3')]);
    expect(ticket?.items.map((i) => i.customId)).toEqual(['b1']);
    expect(refused.map((r) => [r.customId, r.error.code])).toEqual([
      ['b2', 'ai_budget_exhausted'],
      ['b3', 'ai_budget_exhausted'],
    ]);
  });

  it('rejects duplicate or unsafe custom ids', async () => {
    const deps = testDeps(new FakeTransport());
    await expect(submitBatch(deps, [item('x'), item('x')])).rejects.toMatchObject({
      code: 'ai_input_invalid',
    });
    await expect(submitBatch(deps, [item('has space')])).rejects.toMatchObject({
      code: 'ai_input_invalid',
    });
    await expect(submitBatch(deps, [item('a'.repeat(65))])).rejects.toMatchObject({
      code: 'ai_input_invalid',
    });
  });

  it('retries batch creation on a 500 and releases every reservation if it gives up', async () => {
    const transport = new FakeTransport();
    const fail = () =>
      new InternalServerError(
        500,
        { type: 'error', error: { type: 'api_error', message: 'x' } },
        'x',
        new Headers(),
      );
    transport.batchErrors.push(fail(), fail(), fail());
    const deps = testDeps(transport);
    await expect(submitBatch(deps, [item('c1')])).rejects.toMatchObject({
      code: 'ai_server_error',
    });
    expect(deps.sleeps).toHaveLength(2);
    expect(deps.ledger.usage(TENANT, '2026-10')).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0 });
  });
});

describe('chunkBatchItems', () => {
  it('splits by request count and by bytes', () => {
    const items = ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => item(id));
    expect(chunkBatchItems(items, { maxRequests: 2 }).map((c) => c.length)).toEqual([2, 2, 1]);
    const size = Buffer.byteLength(
      JSON.stringify({ custom_id: 'd1', params: items[0]?.call.params }),
    );
    expect(chunkBatchItems(items, { maxBytes: size * 3 }).map((c) => c.length)).toEqual([3, 2]);
    expect(() => chunkBatchItems(items, { maxBytes: 10 })).toThrow(
      expect.objectContaining({ code: 'ai_request_too_large' }),
    );
  });
});

describe('collectBatch and retireBatch', () => {
  it('settles, records and interprets every result, in any order', async () => {
    const transport = new FakeTransport();
    const deps = testDeps(transport);
    const items = [item('e1'), item('e2'), item('e3'), item('e4'), item('e5')];
    const { ticket } = await submitBatch(deps, items);
    if (ticket === null) throw new Error('no ticket');
    transport.batchResultsScript = [
      { customId: 'e3', type: 'expired' },
      {
        customId: 'e1',
        type: 'succeeded',
        message: message(draft, { usage: { input_tokens: 1000, output_tokens: 60 } }),
      },
      { customId: 'e2', type: 'succeeded', message: message('not json') },
      { customId: 'e4', type: 'errored', errorType: 'invalid_request_error' },
      { customId: 'ghost', type: 'succeeded', message: message(draft) },
    ];
    expect((await pollBatch(deps, ticket.batchId)).processingStatus).toBe('ended');
    const calls = new Map(items.map((i) => [i.customId, i.call]));
    const outcomes = await collectBatch(deps, ticket, (id) => calls.get(id));
    const byId = new Map(outcomes.map((o) => [o.customId, o]));
    expect(byId.get('e1')).toMatchObject({ ok: true, result: { status: 'draft' } });
    // 1000 × $0.05 + 60 × $0.25 per million at batch prices = 50 + 15 µ$.
    expect(byId.get('e1')?.record?.costMicroUsd).toBe(65);
    expect(byId.get('e1')?.record?.mode).toBe('batch');
    expect(byId.get('e2')).toMatchObject({ ok: false, error: { code: 'ai_output_malformed' } });
    expect(byId.get('e3')).toMatchObject({
      ok: false,
      error: { code: 'ai_server_error', retryable: true },
    });
    expect(byId.get('e4')).toMatchObject({
      ok: false,
      error: { code: 'ai_invalid_request', retryable: false },
    });
    expect(byId.get('e5')).toMatchObject({ ok: false, error: { code: 'ai_server_error' } });
    expect(byId.has('ghost')).toBe(false);
    expect(deps.records.map((r) => r.outcome).sort()).toEqual(['malformed', 'ok']);
    const totals = deps.ledger.usage(TENANT, '2026-10');
    expect(totals.reservedMicroUsd).toBe(0);
    expect(totals.spentMicroUsd).toBe(deps.records.reduce((s, r) => s + r.costMicroUsd, 0));

    await retireBatch(deps, ticket.batchId);
    expect(transport.batches.get(ticket.batchId)?.deleted).toBe(true);
  });

  it('refuses to interpret with a call that differs from the submitted one', async () => {
    const transport = new FakeTransport();
    const deps = testDeps(transport);
    const { ticket } = await submitBatch(deps, [item('f1')]);
    if (ticket === null) throw new Error('no ticket');
    transport.batchResultsScript = [{ customId: 'f1', type: 'succeeded', message: message(draft) }];
    const escalated = prepareAltText(input, { tenantId: TENANT, escalated: true });
    const [outcome] = await collectBatch(deps, ticket, () => escalated);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'ai_input_invalid' } });
  });
});
