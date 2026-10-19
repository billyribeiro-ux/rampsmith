// The browser check (corpus/CONTRACT.md, check 5): each theme page, rendered statically and
// loaded in Chromium, fires exactly its golden axe-core findings, and each control fires none.
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTheme, launchChromium, type PageResult } from '../src/browser/check.ts';
import { loadCorpus } from '../src/corpus.ts';

const corpus = loadCorpus();
let browser: Browser;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser.close();
});

const clean = { missing: [], unexpected: [], countMismatch: [], impactMismatch: [], duplicate: [] };

describe.each(corpus.themes.map((t) => [t.entry.name, t] as const))(
  'theme %s in Chromium',
  (_name, t) => {
    let results: PageResult[] = [];

    beforeAll(async () => {
      results = await checkTheme(browser, t.renderer, t.entry, t.golden, corpus.manifest.checker);
    });

    it('fires exactly the golden axe-core findings on every page', () => {
      expect(results.map((r) => r.page)).toEqual(t.entry.pages.map((p) => p.id));
      for (const result of results) {
        expect({ page: result.page, ...result.comparison }).toEqual({
          page: result.page,
          ...clean,
        });
      }
    });

    it('ran every rule a golden finding names', () => {
      const ran = new Set(results.flatMap((r) => r.rulesRun));
      for (const finding of t.golden.findings.filter((f) => f.engine === 'axe')) {
        expect(ran.has(finding.ruleId), finding.ruleId).toBe(true);
      }
    });

    it('finds every element a custom-rule occurrence names', () => {
      for (const result of results) {
        expect({ page: result.page, mismatch: result.customSelectorMismatch }).toEqual({
          page: result.page,
          mismatch: [],
        });
      }
    });

    if (t.entry.kind === 'control') {
      it('is clean: no violation and no incomplete result on any page', () => {
        for (const result of results) {
          expect({ page: result.page, nodes: result.nodes }).toEqual({
            page: result.page,
            nodes: [],
          });
        }
      });
    }
  },
);
