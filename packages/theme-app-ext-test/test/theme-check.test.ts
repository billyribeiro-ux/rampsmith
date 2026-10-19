// Shopify Theme Check on the extension, with the theme-app-extension config, failing on any
// offense of any severity. Theme Check would otherwise download the Liquid docs from the
// main branch of Shopify/theme-liquid-docs on every run; this suite points it at a missing
// local root and an empty cache, so it runs on the docs bundled with the pinned
// @shopify/theme-check-node release, offline and the same every time (ADR-161).
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ThemeCheckModule from '@shopify/theme-check-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSION_DIR } from '../src/paths.ts';

type ThemeCheck = typeof ThemeCheckModule;

const work = mkdtempSync(join(tmpdir(), 'rs-theme-check-'));
const logs: string[] = [];
let themeCheck: ThemeCheck;

interface Found {
  readonly check: string;
  readonly severity: number;
  readonly file: string;
  readonly message: string;
}

async function run(root: string): Promise<Found[]> {
  const result = await themeCheck.themeCheckRun(root, join(root, '.theme-check.yml'), (m) =>
    logs.push(m),
  );
  return result.offenses.map((o) => ({
    check: o.check,
    severity: o.severity,
    file: o.uri.slice(o.uri.lastIndexOf('/', o.uri.lastIndexOf('/') - 1) + 1),
    message: o.message,
  }));
}

beforeAll(async () => {
  process.env['XDG_CACHE_HOME'] = join(work, 'cache');
  process.env['SHOPIFY_TLD_ROOT'] = join(work, 'no-download');
  themeCheck = await import('@shopify/theme-check-node');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('Shopify Theme Check', () => {
  it('reports no offense of any severity on the extension', async () => {
    expect(await run(EXTENSION_DIR)).toEqual([]);
  });

  it('ran on the bundled Liquid docs, never a download', () => {
    expect(logs.some((m) => m.startsWith('Loaded fallback'))).toBe(true);
    expect(logs.some((m) => m.includes('Successfully downloaded'))).toBe(false);
  });

  it('checks these files in the app context, so a clean result means something', async () => {
    const copy = join(work, 'broken');
    cpSync(EXTENSION_DIR, copy, { recursive: true });
    writeFileSync(
      join(copy, 'blocks', 'broken.liquid'),
      [
        "{{ 'report.not_a_key' | t }}",
        '<script src="{{ \'rampsmith-barrier-report.js\' | asset_url }}"></script>',
        "{% include 'rampsmith-a11y-styles' %}",
        "{{ 'missing.js' | asset_url }}",
      ].join('\n'),
    );
    const checks = new Set((await run(copy)).map((o) => o.check));
    for (const check of [
      'TranslationKeyExists',
      'ParserBlockingScript',
      'AppBlockValidTags',
      'AppBlockMissingSchema',
      'MissingAsset',
    ]) {
      expect(checks).toContain(check);
    }
  });
});
