import { remediationLogCsv, remediationLogJson, renderStatement } from '@rampsmith/reports';
import { describe, expect, it } from 'vitest';
import { remediationEntry, statementInput } from './reports.server.ts';
import type { FindingSummary, FixSummary, Overview, StatementContent } from './types.ts';

const fix = (over: Partial<FixSummary> = {}): FixSummary => ({
  id: '00000000-0000-4000-8000-000000000501',
  status: 'verified',
  origin: 'ai',
  kind: 'data',
  channel: 'admin_api',
  model: 'claude-sonnet-5',
  confidence: 0.9,
  change: {
    type: 'alt_text',
    resource_gid: 'gid://shopify/MediaImage/1',
    field: 'alt',
    before: null,
    after: 'A blue mug',
    language: 'en',
    contains_text: false,
    escalated: false,
    flags: [],
  },
  product_title: 'Mug',
  image_url: null,
  findings: [
    {
      id: 'f1',
      rule_id: 'image-alt',
      title: 'Image has no alt',
      criteria: ['1.1.1'],
      impact: 'serious',
    },
  ],
  edited: false,
  proposed_at: '2026-10-20T09:00:00Z',
  approved_at: '2026-10-20T09:05:00Z',
  approver_name: 'Sam Merchant',
  applied_at: '2026-10-20T09:06:00Z',
  verified_at: '2026-10-27T09:00:00Z',
  verified_scan: '00000000-0000-4000-8000-000000000002',
  reverts: null,
  error_code: null,
  before_evidence_id: null,
  after_evidence_id: null,
  ...over,
});

const overview = (over: Partial<Overview> = {}): Overview => ({
  shop: { domain: 'demo-store.myshopify.com', name: 'Demo Store' },
  entitlements: {
    plan: 'growth',
    scan_cadence: 'daily',
    alt_text_drafts: { limit: 1, used: 0, renews_at: null },
    features: [],
  },
  latest_scan: {
    id: 's',
    status: 'succeeded',
    trigger: 'manual',
    created_at: '2026-10-20T09:00:00Z',
    started_at: '2026-10-20T09:00:00Z',
    finished_at: '2026-10-20T09:05:00Z',
    pages_planned: 6,
    pages_done: 6,
    checks_run: 100,
    checks_passed: 90,
    error_code: null,
    ruleset_version: 'axe-core 4.11.0+abc',
    coverage: { automated: ['1.1.1', '4.1.2'], partial: ['1.3.1'], review_queue: 2 },
  },
  next_scan_at: null,
  open_by_impact: { minor: 0, moderate: 0, serious: 1, critical: 0 },
  fixes_awaiting_approval: 0,
  fixes_applied: 1,
  first_fix_at: null,
  ...over,
});

const finding: FindingSummary = {
  id: 'f1',
  rule_id: 'image-alt',
  title: 'Product images have no alt text',
  criteria: ['1.1.1'],
  impact: 'serious',
  status: 'open',
  origin: 'data',
  occurrence_count: 3,
  templates_affected: 2,
  on_purchase_path: true,
  priority_score: 90,
  fix: null,
};

const content = (over: Partial<StatementContent> = {}): StatementContent => ({
  organization: ' Demo Store Ltd ',
  contact: {
    email: 'a11y@demo.example',
    phone: '',
    postal_address: '',
    form_url: '',
    response_time: '',
  },
  measures: ['We test with a screen reader', '  '],
  limitations: [
    { description: 'Old size chart is an image', reason: '', alternative: 'Email us' },
    { description: '   ', reason: 'x', alternative: 'y' },
  ],
  compatibility: '',
  ...over,
});

describe('remediationEntry', () => {
  it('maps a verified AI fix so the log package accepts it', () => {
    const entry = remediationEntry(fix());
    expect(entry.approver).toEqual({ kind: 'user', name: 'Sam Merchant' });
    expect(entry.verification?.scanId).toBe('00000000-0000-4000-8000-000000000002');
    expect(entry.change).toMatchObject({ kind: 'data', before: '', after: 'A blue mug' });
    const input = {
      locale: 'en',
      site: {
        name: 'Demo Store',
        url: 'https://demo-store.myshopify.com',
        platform: 'shopify' as const,
      },
      generatedAt: new Date('2026-10-28T00:00:00Z'),
      entries: [entry],
    };
    expect(remediationLogCsv(input)).toContain('gid://shopify/MediaImage/1');
    expect(JSON.parse(remediationLogJson(input))).toBeTypeOf('object');
  });

  it('maps a fix that nobody approved, a system approval and a reverted fix', () => {
    const waiting = remediationEntry(
      fix({
        status: 'proposed',
        approved_at: null,
        approver_name: null,
        applied_at: null,
        verified_at: null,
        verified_scan: null,
      }),
    );
    expect(waiting.approver).toBeNull();
    expect(waiting.verification).toBeUndefined();
    expect(remediationEntry(fix({ approver_name: null })).approver).toEqual({ kind: 'system' });
    expect(remediationEntry(fix({ reverts: 'abc' })).reverts).toBe('abc');
  });

  it('names no model for a rule fix', () => {
    expect(remediationEntry(fix({ origin: 'rule', model: null })).model).toBeUndefined();
    expect(remediationEntry(fix({ model: null })).model).toBe('unknown');
  });
});

describe('statementInput', () => {
  const now = new Date('2026-10-28T00:00:00Z');

  it('builds an input the statement renderer accepts and tidies the merchant text', () => {
    const input = statementInput({
      overview: overview(),
      findings: [finding],
      content: content(),
      locale: 'en',
      now,
    });
    expect(input.organization).toBe('Demo Store Ltd');
    expect(input.measures).toEqual(['We test with a screen reader']);
    expect(input.limitations).toEqual([
      { description: 'Old size chart is an image', alternative: 'Email us' },
    ]);
    expect(input.contact).toEqual({ email: 'a11y@demo.example' });
    expect(input.scanFrequency).toBe('daily');
    expect(input.coverage).toEqual({
      automated: ['1.1.1', '4.1.2'],
      partial: ['1.3.1'],
      rulesetVersion: 'axe-core 4.11.0+abc',
      reviewQueue: 2,
    });
    const rendered = renderStatement(input);
    expect(rendered.status).toBe('known_barriers');
    expect(rendered.text).toContain('Product images have no alt text');
    for (const word of ['compliant', 'lawsuit-proof', 'guaranteed', 'certified']) {
      expect(rendered.text.toLowerCase()).not.toContain(word);
    }
  });

  it('renders before the first scan finishes, as not evaluated', () => {
    const input = statementInput({
      overview: overview({ latest_scan: null }),
      findings: [],
      content: content(),
      locale: 'en',
      now,
    });
    expect(input.latestScan).toBeUndefined();
    expect(renderStatement(input).status).toBe('not_evaluated');
  });

  it('falls back to the shop name and leaves the frequency out on a monthly plan', () => {
    const input = statementInput({
      overview: overview({
        entitlements: {
          plan: 'free',
          scan_cadence: 'monthly',
          alt_text_drafts: { limit: 1, used: 0, renews_at: null },
          features: [],
        },
      }),
      findings: [],
      content: content({ organization: '' }),
      locale: 'en',
      now,
    });
    expect(input.organization).toBe('Demo Store');
    expect(input.scanFrequency).toBeUndefined();
  });

  it('refuses a statement with no way to contact the merchant', () => {
    const input = statementInput({
      overview: overview(),
      findings: [],
      content: content({
        contact: { email: '', phone: '', postal_address: '', form_url: '', response_time: '' },
      }),
      locale: 'en',
      now,
    });
    expect(() => renderStatement(input)).toThrow();
  });
});
