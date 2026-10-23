/**
 * The mailer holds the Amazon SES keys and must never be able to start a browser (ADR-276,
 * audit M1): its import graph, read from the source, reaches no Chromium code, and the packages
 * it uses do not depend on a browser library.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const BROWSER_PACKAGES = ['playwright', 'playwright-core', '@axe-core/playwright', 'puppeteer'];
// `import type` and `export type` are erased before Node runs the file, so they load nothing; an
// `import { type X }` is not (it leaves an empty import behind), so it is counted.
const IMPORT =
  /(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/gu;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? '');
}

function graph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

describe('the mailer entry point', () => {
  const { files, bare } = graph(resolve(SRC, 'mailer.ts'));

  it('reaches no browser code of the engine', () => {
    const names = [...files].map((f) => f.slice(SRC.length + 1));
    for (const forbidden of [
      'browser.ts',
      'worker.ts',
      'queues.ts',
      'free-scan.ts',
      'scan-page.ts',
    ]) {
      expect(names, `mailer.ts imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no browser library, directly or through the workspace packages it uses', () => {
    for (const name of BROWSER_PACKAGES) {
      expect([...bare], `mailer.ts imports ${name}`).not.toContain(name);
    }
    for (const spec of bare) {
      if (!spec.startsWith('@rampsmith/')) continue;
      // `@rampsmith/a11y-rules/rules` is the package a11y-rules, read through one subpath.
      const dir = resolve(SRC, '../../', spec.split('/').slice(1, 2).join('/'));
      const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const name of BROWSER_PACKAGES) {
        expect(
          Object.keys(manifest.dependencies ?? {}),
          `${spec} depends on ${name}`,
        ).not.toContain(name);
      }
    }
  });

  it('reads the rules table alone from a11y-rules, never its main entry, which loads the browser checks', () => {
    const all = [...files].flatMap((file) => importsOf(file));
    expect(all).not.toContain('@rampsmith/a11y-rules');
  });

  it('serves email.send and nothing else, and the engine no longer serves it', async () => {
    const { ENGINE_QUEUES } = await import('../src/queues.ts');
    expect(ENGINE_QUEUES as readonly string[]).not.toContain('email.send');
    expect(readFileSync(resolve(SRC, 'mailer.ts'), 'utf8')).toContain(
      "MAILER_QUEUES = ['email.send'] as const",
    );
  });
});
