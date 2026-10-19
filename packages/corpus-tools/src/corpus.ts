// Loads the whole corpus: manifest, themes, stores, golden files and a renderer per theme.
import type { GoldenFile } from './golden.ts';
import {
  loadGolden,
  loadManifest,
  storeEntry,
  themeDir,
  type Manifest,
  type StoreEntry,
  type ThemeEntry,
} from './manifest.ts';
import { ThemeRenderer } from './render/renderer.ts';
import { loadStore, storeObjects, type StoreFixture, type StoreObjects } from './render/store.ts';
import { loadTheme, type Theme } from './render/theme.ts';
import { ruleCatalog } from './rules.ts';
import type { GoldenContext } from './verify.ts';

export interface LoadedStore {
  readonly entry: StoreEntry;
  readonly fixture: StoreFixture;
  readonly objects: StoreObjects;
  readonly golden: GoldenFile;
}

export interface LoadedTheme {
  readonly entry: ThemeEntry;
  readonly theme: Theme;
  readonly golden: GoldenFile;
  readonly store: LoadedStore;
  readonly renderer: ThemeRenderer;
}

export interface Corpus {
  readonly manifest: Manifest;
  readonly stores: readonly LoadedStore[];
  readonly themes: readonly LoadedTheme[];
}

export function loadCorpus(): Corpus {
  const manifest = loadManifest();
  const stores = manifest.stores.map((entry) => {
    const fixture = loadStore(entry.fixtures);
    return { entry, fixture, objects: storeObjects(fixture), golden: loadGolden(entry.golden) };
  });
  const themes = manifest.themes.map((entry) => {
    const store = stores.find((s) => s.entry.name === storeEntry(manifest, entry.store).name);
    if (store === undefined) throw new Error(`theme ${entry.name} names an unknown store`);
    const theme = loadTheme(entry.name, themeDir(entry));
    return {
      entry,
      theme,
      golden: loadGolden(entry.golden),
      store,
      renderer: new ThemeRenderer(theme, store.objects),
    };
  });
  return { manifest, stores, themes };
}

/** What `verifyGolden` needs to check a theme's or a store's golden file. */
export function goldenContext(corpus: Corpus, subject: LoadedTheme | LoadedStore): GoldenContext {
  const catalog = ruleCatalog();
  if ('theme' in subject) {
    return {
      manifest: corpus.manifest,
      catalog,
      theme: subject.theme,
      pages: subject.entry.pages.map((p) => p.id),
      store: subject.store.fixture,
    };
  }
  return { manifest: corpus.manifest, catalog, theme: null, pages: [], store: subject.fixture };
}
