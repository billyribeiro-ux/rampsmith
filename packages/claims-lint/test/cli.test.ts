import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';

let root: string;

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const config = {
  include: ['**/messages/**/*.json', 'listing/**/*.md', '**/*.svelte'],
  exclude: ['**/node_modules/**', 'packages/claims-lint/**'],
  allowlist: 'claims-lint.allow.json',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claims-lint-'));
  write('claims-lint.config.json', JSON.stringify(config));
  write('claims-lint.allow.json', JSON.stringify({ entries: [] }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('run', () => {
  it('passes when every included file is honest', () => {
    write('apps/web/messages/en.json', '{ "score": "Passes {n} of {m} automated checks" }');
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(0);
    expect(result.output.at(-1)).toMatch(/1 file scanned, no banned claims/);
  });

  it('fails with file, line, column and rule for each violation', () => {
    write('listing/app-store.md', '# Rampsmith\n\nMake your store ADA compliant.\n');
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContainEqual(
      expect.stringMatching(/^listing\/app-store\.md:3:21 compliance /),
    );
  });

  it('emits GitHub annotations when running in Actions', () => {
    write('apps/web/src/routes/+page.svelte', '<h1>Guaranteed results</h1>');
    const result = run({ cwd: root, githubActions: true });
    expect(result.output).toContainEqual(
      expect.stringMatching(
        /^::error file=apps\/web\/src\/routes\/\+page\.svelte,line=1,col=5,title=claims-lint guarantee::/,
      ),
    );
  });

  it('skips directories that match an include glob', () => {
    const dirConfig = { ...config, include: ['listing/**/*'] };
    write('claims-lint.config.json', JSON.stringify(dirConfig));
    write('listing/screenshots/readme.md', 'Passes 12 of 14 automated checks');
    write('listing/app-store.md', 'Fixes barriers at the source');
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(0);
    expect(result.output.at(-1)).toMatch(/2 files scanned, no banned claims/);
  });

  it('ignores excluded paths and files outside the include globs', () => {
    write('node_modules/x/messages/en.json', '{ "a": "certified" }');
    write('packages/claims-lint/test/x.svelte', '<p>certified</p>');
    write('docs/PLAN.md', 'Never say lawsuit-proof.');
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(0);
  });

  it('applies the allowlist and fails on entries that match nothing', () => {
    write('apps/web/messages/en.json', '{ "terms": "Rampsmith does not guarantee any outcome." }');
    write(
      'claims-lint.allow.json',
      JSON.stringify({
        entries: [
          {
            file: 'apps/web/messages/en.json',
            rule: 'guarantee',
            text: 'does not guarantee',
            reason: 'Terms disclaimer reviewed by counsel',
          },
          {
            file: 'apps/web/messages/en.json',
            rule: 'certified',
            text: 'certified',
            reason: 'Stale entry nobody removed',
          },
        ],
      }),
    );
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContainEqual(
      expect.stringMatching(/unused allowlist entry.*certified/),
    );
    expect(result.output.join('\n')).not.toMatch(/en\.json:1:\d+ guarantee/);
  });

  it('fails on a malformed config instead of scanning nothing', () => {
    write('claims-lint.config.json', JSON.stringify({ include: [] }));
    const result = run({ cwd: root, githubActions: false });
    expect(result.exitCode).toBe(2);
    expect(result.output.join('\n')).toMatch(/include/);
  });
});
