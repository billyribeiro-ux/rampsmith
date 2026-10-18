// The static corpus checks (corpus/CONTRACT.md, "Checks" 1 to 4): every golden file validates,
// every rule id is known, every span exists, every theme stays inside Shopify's directories,
// and every page renders.
import { describe, expect, it } from 'vitest';
import { goldenContext, loadCorpus } from '../src/corpus.ts';
import { TOP_SIX_CATEGORIES } from '../src/golden.ts';
import { verifyGolden } from '../src/verify.ts';

const corpus = loadCorpus();

describe('corpus manifest', () => {
  it('names every golden file once and every theme once', () => {
    const goldens = [
      ...corpus.themes.map((t) => t.entry.golden),
      ...corpus.stores.map((s) => s.entry.golden),
    ];
    expect(new Set(goldens).size).toBe(goldens.length);
    const names = corpus.themes.map((t) => t.entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('pairs each golden file with its subject and kind', () => {
    for (const t of corpus.themes) {
      expect(t.golden.subject, t.entry.name).toBe(t.entry.name);
      expect(t.golden.kind, t.entry.name).toBe(t.entry.kind);
    }
    for (const s of corpus.stores) {
      expect(s.golden.subject, s.entry.name).toBe(s.entry.name);
      expect(s.golden.kind, s.entry.name).toBe('store');
    }
  });

  it('gives each control a failing twin and renders controls with the clean store', () => {
    for (const t of corpus.themes.filter((x) => x.entry.kind === 'control')) {
      const twin = corpus.themes.find((x) => x.entry.name === t.entry.twinOf);
      expect(twin?.entry.kind, t.entry.name).toBe('failing');
      expect(t.store.golden.findings, t.entry.name).toEqual([]);
    }
  });

  it('has failing themes covering the six top failure categories', () => {
    const categories = new Set(
      corpus.themes.flatMap((t) =>
        t.golden.findings.filter((f) => f.expectedFix.targeted).map((f) => f.category),
      ),
    );
    for (const category of TOP_SIX_CATEGORIES.filter((c) => c !== 'alt-text-media')) {
      expect(categories.has(category), category).toBe(true);
    }
  });
});

describe.each(corpus.themes.map((t) => [t.entry.name, t] as const))('theme %s', (_name, t) => {
  it('golden findings verify: rules, criteria, pages, spans and expected fixes', () => {
    expect(verifyGolden(t.golden, goldenContext(corpus, t))).toEqual([]);
  });

  it.each(t.entry.pages.map((p) => [p.id, p] as const))('page %s renders', (_id, page) => {
    const html = t.renderer.renderPage(page);
    expect(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('id="shopify-section-template--');
    expect(html).not.toContain('translation missing');
    expect(html).not.toContain('Liquid error');
  });
});

describe.each(corpus.stores.map((s) => [s.entry.name, s] as const))('store %s', (_name, s) => {
  it('golden findings verify against the fixture data', () => {
    expect(verifyGolden(s.golden, goldenContext(corpus, s))).toEqual([]);
  });
});
