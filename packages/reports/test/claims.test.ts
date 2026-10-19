// Runs the repository's claims-lint CLI (packages/claims-lint) over every rendered output,
// so a banned claim (PLAN §3) in any message, in any report state, fails the build.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { outputs } from './support/outputs.ts';

/** The CLI's own entry point (its `bin`), resolved through this package's dependency on it. */
const CLI = fileURLToPath(import.meta.resolve('@rampsmith/claims-lint/src/main.ts'));

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lint(files: readonly { name: string; content: string }[]): {
  status: number;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'reports-claims-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'claims-lint.config.json'),
    JSON.stringify({ include: ['out/**/*'], allowlist: 'allow.json' }),
  );
  writeFileSync(join(dir, 'allow.json'), JSON.stringify({ entries: [] }));
  mkdirSync(join(dir, 'out'));
  for (const f of files) writeFileSync(join(dir, 'out', f.name), f.content);
  try {
    const output = execFileSync(process.execPath, [CLI], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const e = error as { status: number; stdout: string };
    return { status: e.status, output: e.stdout };
  }
}

describe('claims-lint', () => {
  it('finds no banned claim in any output', () => {
    const files = outputs();
    expect(files.length).toBe(14);
    const result = lint(files);
    expect(result.output).toContain(
      `claims-lint: ${String(files.length)} files scanned, no banned claims`,
    );
    expect(result.status).toBe(0);
  });

  it('is not vacuous: the same run fails on a planted banned claim', () => {
    const result = lint([
      ...outputs(),
      { name: 'planted.html', content: '<p>Your store is now fully compliant.</p>' },
    ]);
    expect(result.status).toBe(1);
    expect(result.output).toContain('out/planted.html:1');
  });
});
