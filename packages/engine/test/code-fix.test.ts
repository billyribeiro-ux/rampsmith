/**
 * The `code_fix.patch` job (ADR-295, ADR-296) against a real database: the scanner's stored
 * occurrences become fixes over the theme files `ctl` stored, the files after each fix are kept
 * for the pull request, and a batch with nothing to fix or a failure keeps no source.
 */
import { JobFailure, uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderedElementOf } from '../src/code-fix/rendered.ts';
import { criterionOf, templateOf, wordingOf } from '../src/code-fix/wording.ts';
import { batchFindings, codeFixPatchHandler, judgementsOf } from '../src/jobs/code-fix.ts';
import type { Occurrence } from '../src/scan-page.ts';
import { recordPage } from '../src/store.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from './db.ts';
import { pageScan } from './scans.ts';

let db: TestDatabase;
let worker: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  worker = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

const LAYOUT = `<!doctype html>
<html>
<head>{{ content_for_header }}</head>
<body>
  {% sections 'header-group' %}
  <main id="MainContent">{{ content_for_layout }}</main>
</body>
</html>
`;
const HEADER = `<header class="site-header">
  <a href="/cart" class="cart-link"><svg class="icon" aria-hidden="true"></svg></a>
</header>
`;
const HEADER_GROUP = `{
  "type": "header",
  "name": "Header group",
  "sections": { "header": { "type": "header", "settings": {} } },
  "order": ["header"]
}
`;
const INDEX = `{ "sections": {}, "order": [] }\n`;
const LOCALE = `{\n  "general": {\n    "ok": "OK"\n  }\n}\n`;
const THEME: Record<string, string> = {
  'layout/theme.liquid': LAYOUT,
  'sections/header.liquid': HEADER,
  'sections/header-group.json': HEADER_GROUP,
  'templates/index.json': INDEX,
  'locales/en.default.json': LOCALE,
};

const occurrence = (rule: string, html: string, section?: string): Occurrence => ({
  ...(section === undefined
    ? {}
    : {
        ancestors: [
          { tag: 'header', attributes: { class: 'site-header' } },
          { tag: 'div', attributes: { id: section, class: 'shopify-section' } },
        ],
      }),
  ruleId: rule,
  impact: 'serious',
  criteria: rule === 'link-name' ? ['2.4.4'] : ['3.1.1'],
  help: rule,
  target: rule === 'link-name' ? '.cart-link' : 'html',
  html,
  section,
});

interface Rig {
  readonly f: Fixture;
  readonly batch: string;
}

async function rig(
  occurrences: Occurrence[],
  judgements: unknown[] = [],
  recipes: 'core' | 'every' = 'core',
): Promise<Rig> {
  const f = await seed(db.owner, `https://${uuidv7()}.myshopify.com`);
  await recordPage(worker, f, pageScan(`https://${uuidv7()}.myshopify.com/`, occurrences), {
    pageType: 'home',
    viewport: 'desktop',
  });
  const installation = uuidv7();
  const repo = uuidv7();
  const batch = uuidv7();
  const installationId = Math.floor(Math.random() * 1_000_000_000) + 1;
  await db.owner`
    insert into github_installations (id, tenant_id, site_id, installation_id, account_login,
                                      account_type, repository_selection, status)
    values (${installation}, ${f.tenantId}, ${f.siteId}, ${installationId}, 'octo', 'User',
            'selected', 'active')`;
  await db.owner`
    insert into github_repos (id, tenant_id, installation_row, repo_id, full_name, default_branch,
                              user_can_push, selected, connected_branch, theme_state)
    values (${repo}, ${f.tenantId}, ${installation}, ${installationId}, 'octo/theme', 'main',
            true, true, 'main', 'ok')`;
  await db.owner`
    insert into code_fix_batches (id, tenant_id, site_id, repo_row, batch_id, status, base_branch,
                                  base_sha, recipes, judgements)
    values (${batch}, ${f.tenantId}, ${f.siteId}, ${repo}, ${`b-${batch.slice(-12)}`}, 'patching',
            'main', ${'a'.repeat(40)}, ${recipes}, ${db.owner.json(judgements as never)})`;
  for (const [path, content] of Object.entries(THEME)) {
    await db.owner`
      insert into code_fix_files (batch_row, tenant_id, path, ordinal, content, blob_sha)
      values (${batch}, ${f.tenantId}, ${path}, 0, ${content}, ${'b'.repeat(40)})`;
  }
  return { f, batch };
}

const run = (r: Rig) =>
  codeFixPatchHandler({ sql: worker })({
    payloadSchema: 'code_fix.patch@1',
    payload: { batch_row: r.batch },
    tenantId: r.f.tenantId,
  });

const CART_LINK =
  '<a href="/cart" class="cart-link"><svg class="icon" aria-hidden="true"></svg></a>';

describe('the scanner keeps what the mapper needs (ADR-296)', () => {
  it('stores the section wrapper and the contrast reading, and nothing malformed', async () => {
    const f = await seed(db.owner, 'https://keeps.myshopify.com');
    await recordPage(
      worker,
      f,
      pageScan('https://keeps.myshopify.com/', [
        {
          ...occurrence('color-contrast', '<p class="plain">Plain</p>', 'shopify-section-a__hero'),
          evidence: { foreground: '#9b9b9b', background: '#ffffff', font_size_px: 14, bold: false },
        },
        occurrence('image-alt', '<img src="a.png">', 'not-a-section; drop table'),
      ]),
    );
    const rows = await db.owner<
      { rule_id: string; section_id: string | null; evidence: unknown }[]
    >`
      select f.rule_id, o.section_id, o.evidence
        from finding_occurrences o join findings f on f.id = o.finding_id
       where o.scan_id = ${f.scanId} order by f.rule_id`;
    expect(rows).toEqual([
      {
        rule_id: 'color-contrast',
        section_id: 'shopify-section-a__hero',
        evidence: { foreground: '#9b9b9b', background: '#ffffff', font_size_px: 14, bold: false },
      },
      { rule_id: 'image-alt', section_id: null, evidence: null },
    ]);
  });
});

describe('code_fix.patch', () => {
  it('turns stored findings into fixes, files after each fix, and queues the pull request', async () => {
    const r = await rig(
      [
        occurrence('html-has-lang', '<html>'),
        occurrence('link-name', CART_LINK, 'shopify-section-sections--1__header'),
      ],
      [],
    );
    // The link needs a name the person chooses: without one only the language is fixed.
    await run(r);
    const [batch] = await db.owner<
      { status: string; outcome: { fixed: number; skipped: unknown[] } }[]
    >`
      select status, outcome from code_fix_batches where id = ${r.batch}`;
    expect(batch?.status).toBe('ready');
    expect(batch?.outcome.fixed).toBe(1);
    expect(batch?.outcome.skipped).toEqual([
      expect.objectContaining({ code: 'refused', detail: 'invalid-parameter' }),
    ]);
    const fixes = await db.owner<{ rule_id: string; ordinal: number; criterion: string }[]>`
      select rule_id, ordinal, criterion from code_fix_batch_fixes
       where batch_row = ${r.batch} order by ordinal`;
    expect(fixes).toEqual([{ rule_id: 'html-has-lang', ordinal: 1, criterion: '3.1.1' }]);
    const files = await db.owner<{ path: string; ordinal: number; content: string }[]>`
      select path, ordinal, content from code_fix_files
       where batch_row = ${r.batch} and ordinal > 0`;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('layout/theme.liquid');
    expect(files[0]?.content).toMatch(/<html lang="/u);
    const [fix] = await db.owner<
      { kind: string; channel: string; status: string; diff: { files: { diff: string }[] } }[]
    >`
      select f.kind, f.channel, f.status, f.diff from fixes f
        join code_fix_batch_fixes b on b.fix_id = f.id where b.batch_row = ${r.batch}`;
    expect(fix).toMatchObject({ kind: 'code', channel: 'github_pr', status: 'proposed' });
    expect(fix?.diff.files[0]?.diff).toContain('+<html lang=');
    const jobs = await db.owner<{ queue: string; payload: unknown }[]>`
      select queue, payload from jobs where queue = 'github.open_pr' and tenant_id = ${r.f.tenantId}`;
    expect(jobs).toEqual([{ queue: 'github.open_pr', payload: { batch_row: r.batch } }]);
    // Running it again changes nothing.
    await run(r);
    const [again] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from code_fix_batch_fixes where batch_row = ${r.batch}`;
    expect(again?.n).toBe(1);
  });

  it('uses the accessible name the person brought, and adds the translation', async () => {
    const f = await seed(db.owner, 'https://named.myshopify.com');
    await db.owner`delete from tenants where id = ${f.tenantId}`.catch(() => undefined);
    const r = await rig([
      occurrence('link-name', CART_LINK, 'shopify-section-sections--1__header'),
    ]);
    const [finding] = await db.owner<{ id: string }[]>`
      select id from findings where site_id = ${r.f.siteId}`;
    await db.owner`
      update code_fix_batches
         set judgements = ${db.owner.json([
           { finding_id: finding?.id, label: { key: 'accessibility.cart', text: 'Cart' } },
         ])}
       where id = ${r.batch}`;
    await run(r);
    const files = await db.owner<{ path: string; content: string }[]>`
      select path, content from code_fix_files where batch_row = ${r.batch} and ordinal = 1
       order by path`;
    expect(files.map((x) => x.path)).toEqual(['locales/en.default.json', 'sections/header.liquid']);
    expect(files[0]?.content).toContain('"cart": "Cart"');
    expect(files[1]?.content).toContain("accessibility.cart' | t");
  });

  it('keeps no source and queues nothing when no fix can be made', async () => {
    const r = await rig([occurrence('target-size', '<a class="tiny"></a>')]);
    await db.owner`update findings set fix_kind = 'code' where site_id = ${r.f.siteId}`;
    await run(r);
    const [batch] = await db.owner<{ status: string }[]>`
      select status from code_fix_batches where id = ${r.batch}`;
    expect(batch?.status).toBe('nothing_to_fix');
    const [left] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from code_fix_files where batch_row = ${r.batch}`;
    expect(left?.n).toBe(0);
    const [queued] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from jobs
       where queue = 'github.open_pr' and tenant_id = ${r.f.tenantId}`;
    expect(queued?.n).toBe(0);
  });

  it('does not touch a batch that is not waiting for the engine', async () => {
    const r = await rig([occurrence('html-has-lang', '<html>')]);
    await db.owner`update code_fix_batches set status = 'reading' where id = ${r.batch}`;
    await run(r);
    const [fixes] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from code_fix_batch_fixes where batch_row = ${r.batch}`;
    expect(fixes?.n).toBe(0);
  });

  it('fails permanently for a batch of another tenant, and ends a batch with no files', async () => {
    const r = await rig([occurrence('html-has-lang', '<html>')]);
    const other = await seed(db.owner, 'https://other.myshopify.com');
    await expect(
      codeFixPatchHandler({ sql: worker })({
        payloadSchema: 'code_fix.patch@1',
        payload: { batch_row: r.batch },
        tenantId: other.tenantId,
      }),
    ).rejects.toMatchObject({ failure: { error: { code: 'batch_not_found' } } });
    await db.owner`delete from code_fix_files where batch_row = ${r.batch}`;
    const failure = await run(r).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(JobFailure);
    const [batch] = await db.owner<{ status: string; failure_code: string }[]>`
      select status, failure_code from code_fix_batches where id = ${r.batch}`;
    expect(batch).toEqual({ status: 'failed', failure_code: 'files_missing' });
  });
});

describe('the pieces', () => {
  it('rebuilds a rendered element from an excerpt', () => {
    const el = renderedElementOf(
      `<a class="x y" href='/a?b=1&amp;c=2' data-flag>Shop &amp; save <b>now</b></a>`,
      'shopify-section-s',
    );
    expect(el).toEqual({
      tag: 'a',
      attributes: { class: 'x y', href: '/a?b=1&c=2', 'data-flag': '' },
      text: 'Shop & save now',
      ancestors: [
        { tag: 'div', attributes: { id: 'shopify-section-s', class: 'shopify-section' } },
      ],
    });
    // Cut short in the start tag, or in the content: no element, or no text.
    expect(renderedElementOf('<a class="x', null)).toBeNull();
    expect(renderedElementOf('<a class="x">Shop', null)?.text).toBe('');
    expect(renderedElementOf('<img src="a.png" alt="">', null)).toMatchObject({
      tag: 'img',
      text: '',
      ancestors: [],
    });
    expect(renderedElementOf('text only', null)).toBeNull();
    expect(renderedElementOf('<p>&#128512; &#x41; &bogus; &#0;</p>', null)?.text).toBe(
      '\u{1F600} A &bogus; &#0;',
    );
  });

  it('reads judgements defensively', () => {
    const map = judgementsOf([
      { finding_id: 'a', label: { key: 'k.k', text: 'T' }, id: 'i', decorative_reason: 'r' },
      { finding_id: 'b', label: { key: 1 } },
      { nothing: true },
      'x',
    ]);
    expect(map.get('a')).toEqual({
      label: { key: 'k.k', text: 'T' },
      decorative: { reason: 'r' },
      id: 'i',
    });
    expect(map.get('b')).toEqual({});
    expect(judgementsOf('nope').size).toBe(0);
  });

  it('plans from stored rows', () => {
    const [finding] = batchFindings(
      [{ id: 'f', rule_id: 'color-contrast', criteria: ['1.4.3'] }],
      [
        {
          finding_id: 'f',
          page_type: 'product',
          html_excerpt: '<p class="plain">Plain</p>',
          section_id: null,
          ancestors: [{ tag: 'div', attributes: { class: 'x' } }, 'junk', { tag: 1 }],
          evidence: { foreground: '#9b9b9b', background: '#ffffff', font_size_px: 14, bold: true },
        },
        {
          finding_id: 'f',
          page_type: null,
          html_excerpt: 'cut <',
          section_id: null,
          ancestors: null,
          evidence: 3,
        },
      ],
      new Map(),
    );
    expect(finding?.template).toBe('product');
    expect(finding?.nodes).toHaveLength(1);
    expect(finding?.nodes[0]?.contrast).toEqual({
      background: '#ffffff',
      fontSizePx: 14,
      bold: true,
    });
    expect(finding?.nodes[0]?.evidence).toEqual({ foreground: '#9b9b9b' });
  });

  it('has wording for every rule the planner fixes, safe for a commit subject', () => {
    for (const rule of [
      'html-has-lang',
      'html-lang-valid',
      'image-alt',
      'label',
      'select-name',
      'link-name',
      'button-name',
      'bypass',
      'color-contrast',
    ]) {
      const w = wordingOf(rule);
      expect(w, rule).not.toBeNull();
      expect(w?.summary).toMatch(/^[\p{L}\p{N} ,.'()/&_-]{1,100}$/u);
      expect(w?.finding.length).toBeLessThanOrEqual(300);
      expect(w?.criterion).toMatch(/^[1-4]\.\d{1,2}\.\d{1,2}$/u);
    }
    expect(wordingOf('target-size')).toBeNull();
    expect(criterionOf('image-alt', ['1.1.1'])).toBe('1.1.1');
    expect(criterionOf('image-alt', ['junk'])).toBe('1.1.1');
    expect(criterionOf('nope', [])).toBeNull();
    expect(templateOf('login')).toBe('customers/login');
    expect(templateOf(null)).toBe('index');
  });
});
