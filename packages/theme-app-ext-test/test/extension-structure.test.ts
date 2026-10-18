// The extension's shape: what Shopify CLI deploys, Shopify's limits, the embed's schema, and
// the things the extension must never do (CLAUDE.md, ADR-004, ADR-161).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_ALLOWED,
  LIMITS,
  ROOT_FILES,
  deployedFiles,
  rootEntries,
} from '../src/extension-files.ts';
import { EXTENSION_DIR, SCRIPT_FILE } from '../src/paths.ts';
import { readSchema } from '../src/render.ts';
import { flatten, readLocale } from '../src/locales.ts';
import { SCHEMA_LOCALE } from '../src/paths.ts';

const read = (path: string): string => readFileSync(join(EXTENSION_DIR, path), 'utf8');
const files = deployedFiles();
const liquid = files.filter((f) => f.ext === '.liquid');

describe('shopify.extension.toml', () => {
  it('declares a theme extension with a name and handle, and nothing else', () => {
    const entries = read('shopify.extension.toml')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    const keys = Object.fromEntries(
      entries.map((line) => {
        const match = /^([a-z_]+)\s*=\s*"([^"]*)"$/u.exec(line);
        if (match?.[1] === undefined || match[2] === undefined)
          throw new Error(`unexpected line: ${line}`);
        return [match[1], match[2]];
      }),
    );
    expect(keys).toEqual({
      name: 'rampsmith-accessibility',
      type: 'theme',
      handle: 'rampsmith-accessibility',
    });
    expect(keys['handle']).toMatch(/^[a-z0-9][a-z0-9-]{0,29}$/u);
  });
});

describe('what Shopify CLI deploys', () => {
  it('has only the four deployable directories plus root-level files the CLI never uploads', () => {
    expect(rootEntries()).toEqual(
      [...ROOT_FILES, 'assets', 'blocks', 'locales', 'snippets'].sort(),
    );
  });

  it('keeps every file one level inside an allowed directory, with an allowed extension', () => {
    for (const file of files) {
      expect(file.path.split('/'), file.path).toHaveLength(2);
      expect(CLI_ALLOWED[file.dir], file.path).toContain(file.ext);
    }
    expect(files.map((f) => f.path)).toEqual([
      'assets/rampsmith-barrier-report.js',
      'blocks/accessibility.liquid',
      'locales/en.default.json',
      'locales/en.default.schema.json',
      'snippets/rampsmith-a11y-styles.liquid',
      'snippets/rampsmith-barrier-report.liquid',
    ]);
  });

  it('stays inside Shopify’s limits: 10 MB in all, 100 KB of Liquid, 30 blocks, 100 locale files of 15 KB', () => {
    expect(files.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(LIMITS.totalBytes);
    expect(liquid.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(LIMITS.liquidBytes);
    expect(files.filter((f) => f.dir === 'blocks').length).toBeLessThanOrEqual(LIMITS.blocks);
    const locales = files.filter((f) => f.dir === 'locales');
    expect(locales.length).toBeLessThanOrEqual(LIMITS.localeFiles);
    for (const file of locales) expect(file.bytes, file.path).toBeLessThan(LIMITS.localeFileBytes);
  });

  it('writes JSON without comments or trailing commas, which theme app extensions refuse', () => {
    for (const file of files.filter((f) => f.ext === '.json')) {
      expect(() => JSON.parse(read(file.path)) as unknown, file.path).not.toThrow();
    }
    expect(() => JSON.parse(JSON.stringify(readSchema())) as unknown).not.toThrow();
  });
});

describe('the app embed', () => {
  const schema = readSchema();
  const schemaStrings = flatten(readLocale(SCHEMA_LOCALE));

  it('is one app embed block targeting the end of <body>', () => {
    expect(files.filter((f) => f.dir === 'blocks')).toHaveLength(1);
    expect(schema.target).toBe('body');
  });

  it('has a theme-editor name under 25 characters', () => {
    expect(schema.name).toBe('t:embed.name');
    const name = schemaStrings.get('embed.name') ?? '';
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(25);
  });

  it('loads no script or stylesheet on every page: no schema javascript or stylesheet', () => {
    expect(Object.keys(schema)).toEqual(['name', 'target', 'settings']);
  });

  it('has unique setting ids and translates every label', () => {
    const ids = schema.settings.flatMap((s) => (s.id === undefined ? [] : [s.id]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const setting of schema.settings) {
      for (const [key, value] of Object.entries(setting)) {
        if (['label', 'info', 'content'].includes(key)) expect(String(value)).toMatch(/^t:/u);
      }
    }
  });
});

describe('what the extension never does', () => {
  const sources = files.map((f) => ({ path: f.path, text: read(f.path) }));
  const script = readFileSync(SCRIPT_FILE, 'utf8');

  it('never touches content_for_header, uses include, or draws inline SVG icons', () => {
    for (const { path, text } of sources.filter((s) => s.path.endsWith('.liquid'))) {
      expect(text, path).not.toMatch(/content_for_(header|layout|index)/u);
      expect(text, path).not.toMatch(/\{%-?\s*include\s/u);
      expect(text, path).not.toMatch(/<svg\b/iu);
    }
  });

  it('loads nothing from outside Shopify: no absolute URLs in Liquid or the script', () => {
    for (const { path, text } of sources) {
      if (path.endsWith('.json')) continue;
      expect(text.match(/https?:\/\/[^\s"'<>)]+/gu) ?? [], path).toEqual([]);
    }
  });

  it('has a script that stores nothing, injects no HTML and calls only the form’s own action', () => {
    for (const banned of [
      /document\.cookie/u,
      /localStorage/u,
      /sessionStorage/u,
      /indexedDB/u,
      /innerHTML/u,
      /outerHTML/u,
      /insertAdjacentHTML/u,
      /document\.write/u,
      /\beval\b/u,
      /new Function/u,
      /XMLHttpRequest/u,
      /sendBeacon/u,
      /\bimport\(/u,
    ]) {
      expect(script).not.toMatch(banned);
    }
    expect(script.match(/\bfetch\(/gu)).toEqual(['fetch(']);
    expect(script).toContain('fetch(form.action,');
  });

  it('has no animation or transition to switch off for reduced motion', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\b(animation|transition)\s*:/u);
    }
  });
});
