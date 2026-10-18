/**
 * Runs the claims-lint CLI from packages/claims-lint (PLAN §3) over the subject, preview text,
 * plain text and HTML of every rendered email, the way CI runs it over the repository.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmailRenderer, SHIPPED_CATALOGS, type RenderedEmail } from '../src/index.ts';
import { fixture, SETTINGS } from './fixtures.ts';
import { renderAll } from './helpers.ts';

const cli = join(
  dirname(createRequire(import.meta.url).resolve('@rampsmith/claims-lint/package.json')),
  'src',
  'main.ts',
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeEmails(emails: readonly { name: string; email: RenderedEmail }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'email-claims-'));
  roots.push(root);
  mkdirSync(join(root, 'emails'));
  writeFileSync(
    join(root, 'claims-lint.config.json'),
    JSON.stringify({ include: ['emails/**/*'], allowlist: 'claims-lint.allow.json' }),
  );
  writeFileSync(join(root, 'claims-lint.allow.json'), JSON.stringify({ entries: [] }));
  for (const { name, email } of emails) {
    writeFileSync(
      join(root, 'emails', `${name}.subject.txt`),
      `${email.subject}\n${email.preheader}\n`,
    );
    writeFileSync(join(root, 'emails', `${name}.txt`), email.text);
    writeFileSync(join(root, 'emails', `${name}.html`), email.html);
  }
  return root;
}

function claimsLint(cwd: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('claims-lint CLI over every rendered email', () => {
  it('finds no banned claim in any email', () => {
    const rendered = renderAll().map(({ kind, name, email }) => ({
      name: `${kind}.${name}`,
      email,
    }));
    const result = claimsLint(writeEmails(rendered));
    expect(result.output).toContain(
      `${String(rendered.length * 3)} files scanned, no banned claims`,
    );
    expect(result.status).toBe(0);
  });

  it('fails when a catalog message makes a banned claim (negative control)', () => {
    const tampered = {
      ...SHIPPED_CATALOGS,
      en: { ...SHIPPED_CATALOGS['en'], welcome_title: 'Your store is now guaranteed compliant' },
    };
    const email = createEmailRenderer(SETTINGS, { catalogs: tampered }).render(
      'welcome',
      fixture('welcome'),
    );
    const result = claimsLint(writeEmails([{ name: 'welcome', email }]));
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/welcome\.txt:\d+:\d+ guarantee /u);
    expect(result.output).toMatch(/welcome\.html:\d+:\d+ compliance /u);
  });
});
