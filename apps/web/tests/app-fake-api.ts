/**
 * A stateful fake of the Rust api's `/v1/shopify/` operations, typed against the contract the
 * App Home is written to (`src/lib/app/types.ts`, ADR-091). The App Home specs run the built
 * app against it, so every screen shows realistic data and every action changes state the way
 * lane A's handlers will.
 *
 * Control endpoints (not part of the api): `POST /__scenario {name}` resets the state;
 * `GET /__requests` lists what the app sent, for assertions on the session token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import process from 'node:process';
import type {
  AgencyLink,
  AltTextChange,
  Entitlements,
  FeatureGate,
  FeatureKey,
  FindingDetail,
  FindingSummary,
  FixSummary,
  Draft,
  Impact,
  Overview,
  PlanHandle,
  Regression,
  RegressionList,
  ScanSummary,
  Settings,
  StatementContent,
  StatementState,
} from '../src/lib/app/types.ts';

const port = Number(process.env['FAKE_API_PORT'] ?? '3984');

export type ScenarioName =
  'default' | 'free' | 'starter' | 'fresh' | 'empty' | 'error' | 'flagged' | 'regressed' | 'agency';

interface Product {
  readonly title: string;
  readonly before: string | null;
  readonly after: string;
}

const PRODUCTS: readonly Product[] = [
  { title: 'Blue ceramic mug', before: null, after: 'A deep blue ceramic mug with a wide handle' },
  {
    title: 'Linen tote bag',
    before: 'IMG_2043.jpg',
    after: 'A natural linen tote bag with brown leather straps',
  },
  {
    title: 'Brass desk lamp',
    before: null,
    after: 'A brass desk lamp with an adjustable arm and a round shade',
  },
  {
    title: 'Wool throw blanket',
    before: 'blanket',
    after: 'A grey wool throw blanket folded over a chair',
  },
];

const SEED_TIME = Date.parse('2026-10-20T09:00:00Z');
const iso = (offsetMinutes: number): string =>
  new Date(SEED_TIME + offsetMinutes * 60_000).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The lowest plan that includes each feature (PLAN §20); `null` is every plan. */
const FEATURES: readonly [FeatureKey, PlanHandle | null][] = [
  ['data_fixes', null],
  ['core_recipes', 'starter'],
  ['github_pull_requests', 'starter'],
  ['every_recipe', 'growth'],
  ['description_rewrites', 'growth'],
  ['regression_alerts', 'growth'],
  ['ai_widget_proposals', 'pro'],
  ['multi_language_statements', 'pro'],
  ['priority_queue', 'pro'],
];
const DRAFTS: Record<PlanHandle, number> = { free: 25, starter: 2000, growth: 10_000, pro: 50_000 };
const RANK: Record<PlanHandle, number> = { free: 0, starter: 1, growth: 2, pro: 3 };

function entitlements(plan: PlanHandle, used: number): Entitlements {
  const features: FeatureGate[] = FEATURES.map(([feature, from]) => {
    if (from === null || RANK[plan] >= RANK[from])
      return { feature, gate: 'allowed', unlocked_by: null };
    return { feature, gate: 'locked', unlocked_by: from };
  });
  return {
    plan,
    scan_cadence: plan === 'free' ? 'monthly' : plan === 'starter' ? 'weekly' : 'daily',
    alt_text_drafts: { limit: DRAFTS[plan], used, renews_at: iso(60 * 24 * 12) },
    features,
  };
}

interface FindingSeed {
  readonly rule: string;
  readonly title: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
  readonly origin: 'render' | 'data';
  readonly occurrences: number;
  readonly templates: number;
  readonly purchase: boolean;
  readonly explanation: string;
}

const RENDER_FINDINGS: readonly FindingSeed[] = [
  {
    rule: 'link-name',
    title: 'Links in the cart have no text a screen reader can read',
    criteria: ['2.4.4', '4.1.2'],
    impact: 'critical',
    origin: 'render',
    occurrences: 4,
    templates: 2,
    purchase: true,
    explanation: 'A link needs a name so people using a screen reader know where it goes.',
  },
  {
    rule: 'color-contrast',
    title: 'Sale prices are hard to read against the background',
    criteria: ['1.4.3'],
    impact: 'serious',
    origin: 'render',
    occurrences: 12,
    templates: 3,
    purchase: false,
    explanation:
      'Text needs enough contrast with its background to be read by people with low vision.',
  },
  {
    rule: 'label',
    title: 'The newsletter email field has no label',
    criteria: ['1.3.1', '3.3.2'],
    impact: 'moderate',
    origin: 'render',
    occurrences: 1,
    templates: 1,
    purchase: false,
    explanation: 'Every form field needs a label that says what to enter.',
  },
  {
    rule: 'heading-order',
    title: 'A page skips from a main heading to a level four heading',
    criteria: ['1.3.1'],
    impact: 'minor',
    origin: 'render',
    occurrences: 2,
    templates: 1,
    purchase: false,
    explanation: 'Headings should go down one level at a time so the page outline makes sense.',
  },
];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Scenario {
  plan: PlanHandle;
  scan: ScanSummary | null;
  /** How many reads a running scan still needs before it finishes. */
  scanSteps: number;
  findings: Map<string, FindingDetail>;
  fixes: Map<string, FixSummary>;
  /** Reads left before an approved fix counts as applied. */
  applying: Map<string, number>;
  settings: Settings;
  emailOff: boolean;
  statement: StatementState;
  failing: boolean;
  firstFixAt: string | null;
  regressions: Regression[];
  agencyLinks: AgencyLink[];
  /** Wrong link codes tried; the api refuses more after five. */
  badCodes: number;
  seq: number;
}

let state: Scenario = scenario('default');
const requests: { method: string; path: string; authorization: string | null }[] = [];

function emailPrefs() {
  return {
    address_known: state.settings.notification_email !== null,
    categories: [{ category: 'notification', enabled: !state.emailOff }],
  };
}

function scan(id: number, status: ScanSummary['status'], done: number): ScanSummary {
  const finished = status === 'succeeded';
  return {
    id: uuid(id),
    status,
    trigger: 'manual',
    created_at: iso(0),
    started_at: iso(1),
    finished_at: finished ? iso(6) : null,
    pages_planned: 6,
    pages_done: done,
    checks_run: finished ? 240 : 0,
    checks_passed: finished ? 218 : 0,
    error_code: null,
    ruleset_version: 'axe-core 4.11.0+r1',
    coverage: finished
      ? {
          automated: ['1.1.1', '1.4.3', '2.4.2', '3.1.1', '4.1.2'],
          partial: ['1.3.1', '2.4.4'],
          review_queue: 3,
        }
      : null,
  };
}

function fix(
  n: number,
  product: Product,
  finding: FindingSummary,
  status: FixSummary['status'],
): FixSummary {
  const change: AltTextChange = {
    type: 'alt_text',
    resource_gid: `gid://shopify/MediaImage/${String(1000 + n)}`,
    field: 'alt',
    before: product.before,
    after: product.after,
    language: 'en',
    contains_text: n === 2,
    escalated: false,
    flags: [],
  };
  const applied = status === 'applied' || status === 'verified';
  return {
    id: uuid(0x500 + n),
    status,
    origin: 'ai',
    kind: 'data',
    channel: 'admin_api',
    model: 'claude-sonnet-5',
    confidence: 0.91,
    change,
    product_title: product.title,
    image_url: null,
    findings: [
      {
        id: finding.id,
        rule_id: finding.rule_id,
        title: finding.title,
        criteria: finding.criteria,
        impact: finding.impact,
      },
    ],
    edited: false,
    proposed_at: iso(10 + n),
    approved_at: applied ? iso(20 + n) : null,
    approver_name: applied ? 'Sam Merchant' : null,
    applied_at: applied ? iso(21 + n) : null,
    verified_at: status === 'verified' ? iso(60 * 24 * 7) : null,
    verified_scan: status === 'verified' ? uuid(2) : null,
    reverts: null,
    error_code: null,
    before_evidence_id: null,
    after_evidence_id: null,
  };
}

function populate(s: Scenario, withFixes: 'review' | 'history' | 'none'): void {
  let n = 0;
  PRODUCTS.forEach((product, index) => {
    n += 1;
    const finding: Draft<FindingDetail> = {
      id: uuid(0x100 + n),
      rule_id: 'image-alt',
      title: `The image of ${product.title} has no useful description`,
      criteria: ['1.1.1'],
      impact: 'serious',
      status: 'open',
      origin: 'data',
      occurrence_count: 3,
      templates_affected: 2,
      on_purchase_path: index === 0,
      priority_score: 90 - index,
      fix: null,
      explanation:
        'Images need a short text description so people who cannot see them know what they show.',
      occurrences: [
        {
          page_url: `https://demo-store.myshopify.com/products/${product.title.toLowerCase().replaceAll(' ', '-')}`,
          page_state: 'default',
          target: 'img.product__media',
          html_excerpt: '<img class="product__media" src="/cdn/p.jpg">',
        },
      ],
      templates: ['product', 'collection'],
      evidence: [],
      fixes: [],
    };
    const status: FixSummary['status'] | null =
      withFixes === 'none'
        ? null
        : withFixes === 'history' && index === 0
          ? 'verified'
          : withFixes === 'history' && index === 1
            ? 'applied'
            : 'proposed';
    if (status !== null) {
      const made = fix(n, product, finding, status);
      s.fixes.set(made.id, made);
      finding.fix = { id: made.id, status: made.status };
      finding.fixes = [made as Draft<FixSummary>];
      if (status === 'verified' || status === 'applied')
        finding.status = status === 'verified' ? 'fixed' : 'open';
    }
    s.findings.set(finding.id, finding);
  });
  RENDER_FINDINGS.forEach((seed, index) => {
    s.findings.set(uuid(0x200 + index), {
      id: uuid(0x200 + index),
      rule_id: seed.rule,
      title: seed.title,
      criteria: seed.criteria,
      impact: seed.impact,
      status: 'open',
      origin: seed.origin,
      occurrence_count: seed.occurrences,
      templates_affected: seed.templates,
      on_purchase_path: seed.purchase,
      priority_score: 70 - index * 10,
      fix: null,
      explanation: seed.explanation,
      occurrences: [
        {
          page_url: 'https://demo-store.myshopify.com/cart',
          page_state: 'default',
          target: '.cart__item a',
          html_excerpt: '<a href="/products/mug"><img src="/m.jpg"></a>',
        },
      ],
      templates: ['cart'],
      evidence: [],
      fixes: [],
    });
  });
}

function scenario(name: ScenarioName): Scenario {
  const plan: PlanHandle =
    name === 'free' || name === 'fresh' ? 'free' : name === 'starter' ? 'starter' : 'growth';
  const s: Scenario = {
    plan,
    scan: null,
    scanSteps: 0,
    findings: new Map(),
    fixes: new Map(),
    applying: new Map(),
    settings: {
      weekly_rescan: false,
      notification_email: 'owner@demo-store.example',
      alt_text_max_characters: 150,
      ai_budget_micro_usd: 5_000_000,
      ai_budget_max_micro_usd: 20_000_000,
      storefront_password_set: false,
      entitlements: entitlements(plan, 0),
    },
    emailOff: false,
    statement: { draft: null, versions: [] },
    failing: name === 'error',
    firstFixAt: null,
    regressions: [],
    agencyLinks:
      name === 'agency'
        ? [{ id: uuid(950), organization_name: 'Northwind Digital', granted_at: iso(30) }]
        : [],
    badCodes: 0,
    seq: 100,
  };
  if (
    name === 'default' ||
    name === 'free' ||
    name === 'starter' ||
    name === 'error' ||
    name === 'flagged' ||
    name === 'regressed' ||
    name === 'agency'
  ) {
    s.scan = scan(2, 'succeeded', 6);
    populate(s, 'history');
    s.firstFixAt = iso(21);
    if (name === 'regressed') {
      // The latest scan was a scheduled one: one new issue and one that came back.
      s.scan = { ...s.scan, trigger: 'scheduled' };
      const picks = [...s.findings.values()].slice(0, 2).map(summaryOf);
      s.regressions = [
        {
          id: uuid(900),
          scan_id: s.scan.id,
          previous_scan_id: uuid(1),
          new_count: 1,
          reappeared_count: 1,
          findings_seen: 7,
          previous_findings_seen: 6,
          pass_rate: 90.8,
          previous_pass_rate: 94.2,
          items: picks.map((f, i) => ({
            finding_id: f.id,
            rule_id: f.rule_id,
            title: f.title,
            impact: f.impact,
            criteria: f.criteria,
            kind: i === 0 ? 'new' : 'reappeared',
          })),
          detected_at: iso(6),
          dismissed: false,
        },
      ];
    }
    if (name === 'flagged') {
      // The brass lamp's draft was flagged by the engine (security audit M1): both flags.
      const lamp = [...s.fixes.values()].find((f) => f.product_title === 'Brass desk lamp');
      if (lamp !== undefined) {
        s.fixes.set(lamp.id, {
          ...lamp,
          change: {
            ...lamp.change,
            flags: ['instruction_like_text_seen', 'suspected_prompt_injection'],
          },
        });
      }
    }
  } else if (name === 'empty') {
    s.scan = scan(2, 'succeeded', 6);
  }
  return s;
}

function summaryOf(detail: FindingDetail): FindingSummary {
  return {
    id: detail.id,
    rule_id: detail.rule_id,
    title: detail.title,
    criteria: detail.criteria,
    impact: detail.impact,
    status: detail.status,
    origin: detail.origin,
    occurrence_count: detail.occurrence_count,
    templates_affected: detail.templates_affected,
    on_purchase_path: detail.on_purchase_path,
    priority_score: detail.priority_score,
    fix: detail.fix,
  };
}

function counts(): Overview['open_by_impact'] {
  const out: Record<Impact, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  for (const f of state.findings.values()) if (f.status === 'open') out[f.impact] += 1;
  return out;
}

/** Advances time-based state one read at a time: scans finish, approved fixes get applied. */
function tick(): void {
  if (state.scan !== null && (state.scan.status === 'queued' || state.scan.status === 'running')) {
    state.scanSteps -= 1;
    const done = Math.min(6, 6 - state.scanSteps * 2);
    if (state.scanSteps <= 0) {
      state.scan = scan(3, 'succeeded', 6);
      populate(state, 'review');
    } else {
      state.scan = {
        ...scan(3, 'running', Math.max(0, done)),
        status: done <= 0 ? 'queued' : 'running',
      };
    }
  }
  for (const [id, left] of state.applying) {
    if (left > 1) {
      state.applying.set(id, left - 1);
      continue;
    }
    state.applying.delete(id);
    const current = state.fixes.get(id);
    if (current?.status === 'approved')
      setFix({ ...current, status: 'applied', applied_at: iso(30 + state.seq) });
  }
}

function setFix(next: FixSummary): void {
  state.fixes.set(next.id, next);
  for (const f of next.findings) {
    const detail = state.findings.get(f.id);
    if (detail === undefined) continue;
    const applied = next.status === 'applied' || next.status === 'verified';
    state.findings.set(f.id, {
      ...detail,
      status: applied ? 'fixed' : next.status === 'reverted' ? 'open' : detail.status,
      fix: { id: next.id, status: next.status },
      fixes: [next],
    });
  }
  if (next.status === 'applied' && state.firstFixAt === null) state.firstFixAt = next.applied_at;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: Buffer;
  readonly type?: string;
}

const problem = (
  status: number,
  code: string,
  title: string,
  errors?: { field: string; message: string }[],
): Reply => ({
  status,
  body: { type: 'about:blank', title, status, code, ...(errors === undefined ? {} : { errors }) },
});

function overview(): Overview {
  const fixes = [...state.fixes.values()];
  return {
    shop: { domain: 'demo-store.myshopify.com', name: 'Demo Store' },
    entitlements: state.settings.entitlements,
    latest_scan: state.scan,
    next_scan_at: state.scan?.status === 'succeeded' ? iso(60 * 24 * 7) : null,
    open_by_impact: counts(),
    fixes_awaiting_approval: fixes.filter((f) => f.status === 'proposed').length,
    fixes_applied: fixes.filter((f) => f.status === 'applied' || f.status === 'verified').length,
    first_fix_at: state.firstFixAt,
    regression_banner:
      state.settings.entitlements.plan === 'free' || state.settings.entitlements.plan === 'starter'
        ? null
        : (state.regressions.find((r) => !r.dismissed) ?? null),
  };
}

function regressionList(): RegressionList {
  const plan = state.settings.entitlements.plan;
  const locked = plan === 'free' || plan === 'starter';
  return {
    gate: locked ? 'locked' : 'allowed',
    unlocked_by: locked ? 'growth' : null,
    items: locked ? [] : state.regressions,
  };
}

function route(method: string, url: URL, body: Record<string, unknown>): Reply {
  const path = url.pathname.replace(/^\/v1\/shopify\//u, '');
  const id = path.split('/')[1] ?? '';
  const q = url.searchParams;
  if (method === 'GET' && path === 'overview') {
    tick();
    return { status: 200, body: overview() };
  }
  if (method === 'GET' && path === 'regressions') return { status: 200, body: regressionList() };
  if (method === 'POST' && /^regressions\/[^/]+\/dismiss$/u.test(path)) {
    const found = state.regressions.find((r) => r.id === id);
    if (found === undefined) return problem(404, 'not_found', 'Not found');
    state.regressions = state.regressions.map((r) => (r.id === id ? { ...r, dismissed: true } : r));
    return { status: 204 };
  }
  if (method === 'GET' && path === 'agency-links') {
    return { status: 200, body: { links: state.agencyLinks } };
  }
  if (method === 'POST' && (path === 'agency-links' || path === 'agency-links/preview')) {
    if (state.badCodes >= 5) return problem(429, 'rate_limited', 'Too many codes were not valid');
    const typed = (typeof body['code'] === 'string' ? body['code'] : '')
      .replace(/[\s-]/gu, '')
      .toUpperCase();
    if (typed !== 'ABCDE12345') {
      state.badCodes += 1;
      return problem(404, 'not_found', 'Not found');
    }
    if (path === 'agency-links/preview') {
      return {
        status: 200,
        body: { organization_name: 'Northwind Digital', expires_at: iso(-60 * 23) },
      };
    }
    const link: AgencyLink = {
      id: uuid(951 + state.agencyLinks.length),
      organization_name: 'Northwind Digital',
      granted_at: iso(0),
    };
    state.agencyLinks = [...state.agencyLinks, link];
    return { status: 201, body: link };
  }
  if (method === 'DELETE' && path.startsWith('agency-links/')) {
    const found = state.agencyLinks.find((l) => l.id === id);
    if (found === undefined) return problem(404, 'not_found', 'Not found');
    state.agencyLinks = state.agencyLinks.filter((l) => l.id !== id);
    return { status: 204 };
  }
  if (method === 'POST' && path === 'scans') {
    if (state.scan?.status === 'queued' || state.scan?.status === 'running')
      return problem(409, 'conflict', 'A scan is already running');
    state.scan = scan(3, 'queued', 0);
    state.scanSteps = 3;
    state.findings.clear();
    state.fixes.clear();
    return { status: 202, body: { scan: state.scan } };
  }
  if (method === 'GET' && path.startsWith('scans/')) {
    tick();
    return state.scan === null
      ? problem(404, 'not_found', 'Not found')
      : { status: 200, body: state.scan };
  }
  if (method === 'GET' && path === 'findings') {
    let items = [...state.findings.values()].map(summaryOf);
    const impact = q.get('impact');
    const status = q.get('status');
    const origin = q.get('origin');
    const hasFix = q.get('has_fix');
    if (impact) items = items.filter((f) => f.impact === impact);
    if (status) items = items.filter((f) => f.status === status);
    if (origin) items = items.filter((f) => f.origin === origin);
    if (hasFix) items = items.filter((f) => (f.fix !== null) === (hasFix === 'true'));
    items.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
    return { status: 200, body: { items, total: items.length, next_cursor: null } };
  }
  if (method === 'GET' && path.startsWith('findings/')) {
    const found = state.findings.get(id);
    return found === undefined
      ? problem(404, 'not_found', 'Not found')
      : { status: 200, body: found };
  }
  if (method === 'GET' && path === 'fixes') {
    tick();
    const filter = q.get('state') ?? 'queue';
    const queue = new Set(['proposed', 'approved', 'applying', 'failed']);
    const applied = new Set(['applied', 'verified']);
    const items = [...state.fixes.values()].filter((f) =>
      filter === 'all' ? true : filter === 'queue' ? queue.has(f.status) : applied.has(f.status),
    );
    return { status: 200, body: { items, next_cursor: null } };
  }
  if (path.startsWith('fixes/')) {
    const found = state.fixes.get(id);
    if (found === undefined) return problem(404, 'not_found', 'Not found');
    const action = path.split('/')[2];
    if (method === 'PUT') {
      const alt = typeof body['alt'] === 'string' ? body['alt'].trim() : '';
      if (alt === '' || alt.length > state.settings.alt_text_max_characters) {
        return problem(422, 'validation_failed', 'Invalid alt text', [
          { field: 'alt', message: 'invalid' },
        ]);
      }
      const next = { ...found, edited: true, change: { ...found.change, after: alt } };
      setFix(next);
      return { status: 200, body: next };
    }
    if (method === 'POST' && action === 'approve') {
      if (found.status !== 'proposed') return problem(409, 'conflict', 'Already decided');
      if (found.change.flags.length > 0 && q.get('confirm_flagged') !== 'true')
        return problem(422, 'validation_failed', 'Invalid request', [
          { field: 'confirm_flagged', message: 'must be true' },
        ]);
      const next = {
        ...found,
        status: 'approved' as const,
        approved_at: iso(25),
        approver_name: 'Sam Merchant',
      };
      setFix(next);
      state.applying.set(next.id, 2);
      return { status: 200, body: next };
    }
    if (method === 'POST' && action === 'reject') {
      const next = { ...found, status: 'rejected' as const };
      setFix(next);
      return { status: 200, body: next };
    }
    if (method === 'POST' && action === 'undo') {
      const next = { ...found, status: 'reverted' as const };
      setFix(next);
      return { status: 200, body: next };
    }
  }
  if (method === 'GET' && path.startsWith('evidence/'))
    return { status: 200, raw: PNG, type: 'image/png' };
  if (method === 'GET' && path === 'settings') return { status: 200, body: state.settings };
  if (method === 'PUT' && path === 'settings') {
    const errors: { field: string; message: string }[] = [];
    const email = body['notification_email'];
    if (typeof email === 'string' && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
      errors.push({ field: 'notification_email', message: 'invalid' });
    const chars = body['alt_text_max_characters'];
    if (typeof chars === 'number' && (chars < 40 || chars > 300))
      errors.push({ field: 'alt_text_max_characters', message: 'invalid' });
    const budget = body['ai_budget_micro_usd'];
    if (
      typeof budget === 'number' &&
      (budget < 0 || budget > state.settings.ai_budget_max_micro_usd)
    )
      errors.push({ field: 'ai_budget_micro_usd', message: 'invalid' });
    if (body['weekly_rescan'] === true && state.settings.entitlements.scan_cadence === 'monthly')
      return problem(403, 'forbidden', 'Weekly rescans need a higher plan');
    if (errors.length > 0) return problem(422, 'validation_failed', 'Invalid settings', errors);
    const password = body['storefront_password'];
    state.settings = {
      ...state.settings,
      ...(typeof body['weekly_rescan'] === 'boolean'
        ? { weekly_rescan: body['weekly_rescan'] }
        : {}),
      ...('notification_email' in body
        ? { notification_email: (email as string | null) === '' ? null : (email as string | null) }
        : {}),
      ...(typeof chars === 'number' ? { alt_text_max_characters: chars } : {}),
      ...(typeof budget === 'number' ? { ai_budget_micro_usd: budget } : {}),
      ...(typeof password === 'string'
        ? { storefront_password_set: true }
        : password === null
          ? { storefront_password_set: false }
          : {}),
    };
    return { status: 200, body: state.settings };
  }
  if (method === 'GET' && path === 'email-preferences') return { status: 200, body: emailPrefs() };
  if (method === 'PUT' && path === 'email-preferences') {
    if (body['category'] !== 'notification' || typeof body['enabled'] !== 'boolean')
      return problem(422, 'validation_failed', 'Invalid preference');
    state.emailOff = !body['enabled'];
    return { status: 200, body: emailPrefs() };
  }
  if (method === 'GET' && path === 'statement') return { status: 200, body: state.statement };
  if (method === 'PUT' && path === 'statement') {
    const content = body as unknown as StatementContent;
    const version = state.statement.versions.length + 1;
    state.statement = {
      draft: content,
      versions: [
        {
          id: uuid(0x700 + version),
          version,
          status: 'draft',
          created_at: iso(40 + version),
          published_at: null,
        },
        ...state.statement.versions,
      ],
    };
    return { status: 200, body: state.statement };
  }
  return problem(404, 'not_found', 'Not found');
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function send(response: ServerResponse, reply: Reply): void {
  if (reply.raw !== undefined) {
    response
      .writeHead(reply.status, { 'content-type': reply.type ?? 'application/octet-stream' })
      .end(reply.raw);
    return;
  }
  const isProblem = reply.status >= 400;
  response
    .writeHead(reply.status, {
      'content-type': isProblem ? 'application/problem+json' : 'application/json',
    })
    .end(JSON.stringify(reply.body ?? {}));
}

createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const method = request.method ?? 'GET';
    if (url.pathname === '/healthz') {
      send(response, { status: 200, body: { status: 'ok' } });
      return;
    }
    if (url.pathname === '/__scenario' && method === 'POST') {
      const body = await readBody(request);
      state = scenario((body['name'] as ScenarioName | undefined) ?? 'default');
      requests.length = 0;
      send(response, { status: 200, body: { ok: true } });
      return;
    }
    if (url.pathname === '/__requests') {
      send(response, { status: 200, body: requests });
      return;
    }
    if (!url.pathname.startsWith('/v1/shopify/')) {
      send(response, problem(404, 'not_found', 'Not found'));
      return;
    }

    const authorization = request.headers.authorization ?? null;
    requests.push({ method, path: url.pathname + url.search, authorization });
    if (authorization !== 'Bearer good') {
      response
        .writeHead(401, {
          'content-type': 'application/problem+json',
          'x-shopify-retry-invalid-session-request': '1',
        })
        .end(
          JSON.stringify({
            type: 'about:blank',
            title: 'Authentication required',
            status: 401,
            code: 'unauthenticated',
          }),
        );
      return;
    }
    if (url.pathname === '/v1/shopify/session' && method === 'POST') {
      send(response, {
        status: 200,
        body: { shop: 'demo-store.myshopify.com', installed: true },
      });
      return;
    }
    if (state.failing) {
      send(response, problem(503, 'unavailable', 'Service unavailable'));
      return;
    }
    state.seq += 1;
    send(response, route(method, url, method === 'GET' ? {} : await readBody(request)));
  })();
}).listen(port, '127.0.0.1');
