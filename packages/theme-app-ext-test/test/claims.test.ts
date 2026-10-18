// claims-lint (PLAN §3) over the extension's locale files and Liquid, run through the CLI in
// packages/claims-lint with the repository's own include globs for extensions.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXTENSION_DIR, REPO_DIR } from '../src/paths.ts';

const CLI = join(REPO_DIR, 'packages', 'claims-lint', 'src', 'main.ts');
const rootConfig = JSON.parse(readFileSync(join(REPO_DIR, 'claims-lint.config.json'), 'utf8')) as {
  include: string[];
};
const extensionGlobs = rootConfig.include.filter((glob) => glob.startsWith('extensions/'));
const work = mkdtempSync(join(tmpdir(), 'rs-claims-'));

/** Copies the extension into a scratch repository and runs claims-lint there. */
function lint(name: string, edit?: (dir: string) => void) {
  const root = join(work, name);
  const dir = join(root, 'extensions', 'theme-app-ext');
  cpSync(EXTENSION_DIR, dir, { recursive: true });
  edit?.(dir);
  writeFileSync(
    join(root, 'claims-lint.config.json'),
    JSON.stringify({ include: extensionGlobs, exclude: [], allowlist: 'claims-lint.allow.json' }),
  );
  writeFileSync(join(root, 'claims-lint.allow.json'), JSON.stringify({ entries: [] }));
  // Plain output even on GitHub Actions, where the CLI would otherwise print annotations and
  // the deliberate violation below would show up on the pull request.
  const env = { ...process.env, GITHUB_ACTIONS: 'false' };
  const result = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('claims-lint on the extension', () => {
  it('is configured at the root to cover extension locale files and Liquid', () => {
    expect(extensionGlobs).toEqual(['extensions/**/locales/**/*.json', 'extensions/**/*.liquid']);
  });

  it('finds no banned claim in the five files of copy', () => {
    const { status, output } = lint('clean');
    expect(output).toContain('claims-lint: 5 files scanned, no banned claims');
    expect(status).toBe(0);
  });

  it('fails on a banned claim in a locale string, so the clean result is real', () => {
    const { status, output } = lint('dirty', (dir) => {
      const file = join(dir, 'locales', 'en.default.json');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('"Accessibility"', '"Fully compliant accessibility"'),
      );
    });
    expect(status).toBe(1);
    expect(output).toMatch(/locales\/en\.default\.json:\d+:\d+ compliance/u);
    expect(output).toMatch(/absolute-accessibility/u);
  });
});
