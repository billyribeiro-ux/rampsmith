import { JobFailure } from '@rampsmith/queue';
import { describe, expect, it } from 'vitest';
import { parsePayload, requireTenant, type JobInput } from '../src/jobs/payload.ts';
import { ENGINE_QUEUES, stubHandlers } from '../src/queues.ts';

const SCAN = '0192a3b4-c5d6-7e8f-9012-3456789abcde';
const SITE = '0192a3b4-c5d6-7e8f-9012-3456789abcdf';
const TENANT = '0192a3b4-c5d6-7e8f-9012-3456789abce0';

function job(payloadSchema: string, payload: unknown, tenantId: string | null = TENANT): JobInput {
  return { payloadSchema, payload, tenantId };
}

function failureOf(run: () => unknown): JobFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error('expected a JobFailure');
}

describe('parsePayload validates against the generated JSON Schema (ADR-036)', () => {
  it('accepts a payload that matches its schema', () => {
    const payload = parsePayload(
      job('scan.plan@1', { scan_id: SCAN, site_id: SITE }),
      'scan.plan@1',
    );
    expect(payload).toEqual({ scan_id: SCAN, site_id: SITE });
  });

  it('accepts scan.page@2 with its vocabulary and bounds', () => {
    const wire = {
      scan_id: SCAN,
      site_id: SITE,
      url: 'https://example.myshopify.com/cart',
      page_type: 'cart',
      viewport: 'mobile',
      states: ['default', 'cart_drawer'],
      seq: 3,
    };
    expect(parsePayload(job('scan.page@2', wire), 'scan.page@2')).toEqual(wire);
  });

  it('refuses another schema version permanently', () => {
    const failure = failureOf(() =>
      parsePayload(job('scan.plan@2', { scan_id: SCAN, site_id: SITE }), 'scan.plan@1'),
    );
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('payload_schema_unknown');
  });

  it.each([
    ['an unknown member', { scan_id: SCAN, site_id: SITE, extra: 1 }],
    ['a malformed id', { scan_id: 'scan-1', site_id: SITE }],
    ['a missing member', { scan_id: SCAN }],
    ['a non-object', 'scan'],
  ])('refuses %s permanently, naming no value', (_name, payload) => {
    const failure = failureOf(() => parsePayload(job('scan.plan@1', payload), 'scan.plan@1'));
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('payload_invalid');
    expect(failure.failure.error.message).not.toContain('scan-1');
  });

  it('refuses states outside the vocabulary and an empty state list', () => {
    const page = (states: unknown) => ({
      scan_id: SCAN,
      site_id: SITE,
      url: 'https://example.myshopify.com/',
      page_type: 'home',
      viewport: 'desktop',
      states,
      seq: 0,
    });
    for (const states of [['hover'], []]) {
      const failure = failureOf(() =>
        parsePayload(job('scan.page@2', page(states)), 'scan.page@2'),
      );
      expect(failure.failure.error.code).toBe('payload_invalid');
    }
  });

  it('requires a tenant', () => {
    expect(requireTenant(job('scan.plan@1', {}, TENANT))).toBe(TENANT);
    const failure = failureOf(() => requireTenant(job('scan.plan@1', {}, null)));
    expect(failure.failure.error.code).toBe('tenant_missing');
  });
});

describe('the engine queue registry (ADR-035)', () => {
  it('serves every engine queue once', () => {
    expect([...ENGINE_QUEUES].sort()).toEqual([
      'ai.alt_text',
      'audit.data',
      'scan.finalize',
      'scan.page',
      'scan.plan',
      'verify.scan',
    ]);
  });

  it('fails a valid job on an unbuilt queue permanently as not_implemented', async () => {
    const handlers = stubHandlers();
    const run = handlers['scan.finalize'];
    const valid = {
      ...job('scan.finalize@1', { scan_id: SCAN, site_id: SITE }),
      queue: 'scan.finalize',
    };
    await expect(run(valid)).rejects.toMatchObject({
      failure: { kind: 'permanent', error: { code: 'not_implemented' } },
    });
  });
});
