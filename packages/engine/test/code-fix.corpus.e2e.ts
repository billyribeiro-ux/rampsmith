/**
 * The code-fix pipeline over the theme corpus, shaped like production (ADR-295, ADR-296): each
 * page of a failing theme is rendered, served over HTTP, and scanned by the engine's own scanner
 * (real Chromium, real axe-core); the findings and occurrences are built the way the store keeps
 * them; `planBatch` makes the fixes over the theme's files; the patched theme is rendered and
 * scanned again.
 *
 * This is the measure of the code-fix job rather than of the recipes alone (which
 * `pnpm --filter @rampsmith/corpus-tools exec node src/cli.ts run` measures with the golden
 * joins). Findings that need a person's judgement (a label to write, a reason an image is
 * decorative) are not given any here, so they must be skipped, never guessed.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { planBatch, type BatchPlan } from '@rampsmith/liquid-patch';
import {
  ThemeRenderer,
  loadCorpus,
  type LoadedTheme,
  type PageSpec,
} from '@rampsmith/corpus-tools';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { batchFindings } from '../src/jobs/code-fix.ts';
import { fingerprint } from '../src/fingerprint.ts';
import { scanPage, type Occurrence } from '../src/scan-page.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';
const ASSETS = '/cdn/shop/t/1/assets/';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let browser: Browser;

beforeAll(async () => {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  browser = await launchBrowser({
    chromiumSandbox: false,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
});
afterAll(async () => {
  await browser.close();
});

/**
 * What `ctl` reads from a repository (`wanted` in crates/ctl/src/jobs/code_fix.rs): the Liquid,
 * the JSON templates, section groups, settings and locales, and the stylesheets.
 */
function wanted(path: string): boolean {
  const [top = ''] = path.split('/');
  if (['sections', 'snippets', 'blocks', 'layout', 'templates'].includes(top)) {
    return (
      path.endsWith('.liquid') ||
      (['sections', 'templates'].includes(top) && path.endsWith('.json'))
    );
  }
  if (top === 'config' || top === 'locales') return path.endsWith('.json');
  return top === 'assets' && /\.(css|css\.liquid|scss\.liquid)$/u.test(path);
}

function serve(renderer: ThemeRenderer, pages: readonly PageSpec[]): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const page = pages.find((p) => p.path === `${url.pathname}${url.search}`);
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderer.renderPage(page));
      return;
    }
    if (url.pathname.startsWith(ASSETS)) {
      const asset = renderer.renderAsset(decodeURIComponent(url.pathname.slice(ASSETS.length)));
      if (asset !== null) {
        res.writeHead(200, { 'content-type': asset.contentType });
        res.end(asset.body);
        return;
      }
    }
    if (url.pathname.startsWith('/cdn/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PIXEL);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/** The scanner's page type for a corpus page (the store keeps `home`, not Shopify's `index`). */
function pageTypeOf(page: PageSpec): string {
  const name = page.template.split('.')[0] ?? 'index';
  if (name === 'index') return 'home';
  return name === 'customers/login' ? 'login' : name;
}

interface Seen {
  readonly rule: string;
  readonly criteria: readonly string[];
  readonly occurrences: {
    readonly page_type: string;
    readonly occurrence: Occurrence;
  }[];
}

/** Scans every page of a rendered theme; findings merge by fingerprint, as the store merges them. */
async function scanTheme(
  renderer: ThemeRenderer,
  pages: readonly PageSpec[],
): Promise<Map<string, Seen>> {
  const server = await serve(renderer, pages);
  const port = (server.address() as AddressInfo).port;
  const seen = new Map<string, Seen>();
  try {
    for (const page of pages) {
      const scan = await scanPage(browser, {
        url: `http://127.0.0.1:${String(port)}${page.path}`,
        userAgent: UA,
        quietMs: 200,
      });
      const state = scan.states[0];
      if (state === undefined) throw new Error(`${page.id} was not checked`);
      for (const o of state.violations) {
        const key = Buffer.from(fingerprint(o.ruleId, o.target, o.section ?? '')).toString('hex');
        const entry = seen.get(key) ?? { rule: o.ruleId, criteria: o.criteria, occurrences: [] };
        entry.occurrences.push({ page_type: pageTypeOf(page), occurrence: o });
        seen.set(key, entry);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return seen;
}

interface ThemeResult {
  readonly theme: string;
  readonly findings: number;
  readonly planned: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly planFixed: number;
  readonly stillFiring: string[];
  readonly newFindings: string[];
  readonly rules: Readonly<Record<string, number>>;
  readonly plan: BatchPlan;
}

async function measure(theme: LoadedTheme): Promise<ThemeResult> {
  const pages = theme.entry.pages;
  const before = await scanTheme(theme.renderer, pages);
  const files = new Map([...theme.theme.files].filter(([path]) => wanted(path)));
  const findingRows = [...before.entries()].map(([id, s]) => ({
    id,
    rule_id: s.rule,
    criteria: [...s.criteria],
  }));
  const occurrenceRows = [...before.entries()].flatMap(([id, s]) =>
    s.occurrences.map(({ page_type, occurrence: o }) => ({
      finding_id: id,
      page_type,
      html_excerpt: o.html,
      section_id: o.section ?? null,
      ancestors: o.ancestors ?? null,
      evidence: o.evidence ?? null,
    })),
  );
  const plan = await planBatch(files, batchFindings(findingRows, occurrenceRows, new Map()), {
    contrast: true,
  });
  const fixedIds = plan.steps.map((s) => s.fix.findingId);

  const patched = new Map(theme.theme.files);
  for (const [path, content] of plan.final) patched.set(path, content);
  const after = await scanTheme(
    new ThemeRenderer({ name: theme.theme.name, files: patched }, theme.store.objects),
    pages,
  );
  const skipped: Record<string, number> = {};
  for (const s of plan.skipped) skipped[s.code] = (skipped[s.code] ?? 0) + 1;
  const rules: Record<string, number> = {};
  for (const step of plan.steps) rules[step.fix.rule] = (rules[step.fix.rule] ?? 0) + 1;
  return {
    theme: theme.entry.name,
    findings: before.size,
    planned: plan.steps.length + plan.skipped.length,
    skipped,
    planFixed: fixedIds.length,
    stillFiring: fixedIds.filter((id) => after.has(id)),
    newFindings: [...after.keys()].filter((id) => !before.has(id)),
    rules,
    plan,
  };
}

describe('the code-fix pipeline over the corpus', () => {
  const corpus = loadCorpus();
  const failing = corpus.themes.filter((t) => !t.entry.name.endsWith('-clean'));
  const results: ThemeResult[] = [];

  for (const theme of failing) {
    it(`${theme.entry.name}: every fix removes its finding and adds none`, async () => {
      const result = await measure(theme);
      results.push(result);
      expect(result.planFixed).toBeGreaterThan(0);
      expect(result.stillFiring, 'a finding still fires after its fix').toEqual([]);
      expect(result.newFindings, 'the patched theme has a finding it did not have').toEqual([]);
      // Fixes that need a person's words are skipped, never guessed.
    });
  }

  afterAll(() => {
    const dir = 'test-results';
    mkdirSync(dir, { recursive: true });
    const summary = results.map((r) => ({ ...r, plan: undefined }));
    writeFileSync(`${dir}/code-fix-corpus.json`, `${JSON.stringify(summary, null, 2)}\n`);
    const total = results.reduce((n, r) => n + r.findings, 0);
    const fixed = results.reduce((n, r) => n + r.planFixed, 0);
    process.stdout.write(
      `code-fix corpus: ${String(fixed)} of ${String(total)} findings fixed across ${String(results.length)} themes; ` +
        `${JSON.stringify(Object.fromEntries(results.map((r) => [r.theme, r.skipped])))}\n`,
    );
  });
});
