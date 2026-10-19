// The corpus manifest (corpus/manifest.json): stores, themes and their pages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoldenFile } from './golden.ts';
import { CORPUS_ROOT } from './paths.ts';
import type { PageSpec } from './render/renderer.ts';
import { validate } from './schema.ts';

export interface StoreEntry {
  readonly name: string;
  readonly fixtures: string;
  readonly golden: string;
  readonly description: string;
}

export interface ThemeEntry {
  readonly name: string;
  readonly kind: 'failing' | 'control';
  readonly path: string;
  readonly store: string;
  readonly golden: string;
  readonly description: string;
  readonly twinOf?: string;
  readonly variety: readonly string[];
  readonly pages: readonly PageSpec[];
}

export interface Manifest {
  readonly $schema: string;
  readonly version: 1;
  readonly renderer: { readonly liquidjs: string };
  readonly checker: {
    readonly axeCore: string;
    readonly playwrightCore: string;
    readonly tags: readonly string[];
    readonly viewport: { readonly width: number; readonly height: number };
  };
  readonly stores: readonly StoreEntry[];
  readonly themes: readonly ThemeEntry[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(CORPUS_ROOT, path), 'utf8'));
}

/** Reads and schema-validates `corpus/manifest.json`. */
export function loadManifest(): Manifest {
  const value = readJson('manifest.json');
  const errors = validate('manifest', value);
  if (errors.length > 0) throw new Error(`corpus/manifest.json: ${errors.join('; ')}`);
  return value as Manifest;
}

/** Reads and schema-validates a golden file named by the manifest. */
export function loadGolden(path: string): GoldenFile {
  const value = readJson(path);
  const errors = validate('golden', value);
  if (errors.length > 0) throw new Error(`corpus/${path}: ${errors.join('; ')}`);
  return value as GoldenFile;
}

export function themeDir(entry: ThemeEntry): string {
  return join(CORPUS_ROOT, entry.path);
}

export function storeEntry(manifest: Manifest, name: string): StoreEntry {
  const store = manifest.stores.find((s) => s.name === name);
  if (store === undefined) throw new Error(`the manifest has no store named ${name}`);
  return store;
}
