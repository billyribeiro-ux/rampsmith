import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_IDS, fingerprint, loadPrompts, promptPath } from '../src/prompts.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const claimsLint = fileURLToPath(new URL('../../claims-lint/src/main.ts', import.meta.url));

describe('prompt manifest', () => {
  it('loads every prompt at the version and hash the manifest pins', () => {
    const prompts = loadPrompts();
    expect([...prompts.keys()]).toEqual([...PROMPT_IDS]);
    for (const p of prompts.values()) {
      expect(p.version).toMatch(/^[a-z-]+@\d+$/u);
      expect(fingerprint(p.text, p.schema)).toBe(p.sha256);
    }
  });

  it('changes the fingerprint when the prompt text or its schema changes', () => {
    const p = loadPrompts().get('alt-text');
    expect(p).toBeDefined();
    if (p === undefined) return;
    expect(fingerprint(`${p.text} `, p.schema)).not.toBe(p.sha256);
    const other = loadPrompts().get('rewrite');
    if (other === undefined) return;
    expect(fingerprint(p.text, other.schema)).not.toBe(p.sha256);
  });

  it('keeps one file per version and nothing else in each prompt directory', () => {
    for (const id of PROMPT_IDS) {
      const files = readdirSync(new URL(`../prompts/${id}/`, import.meta.url));
      expect(files.every((f) => /^v\d+\.txt$/u.test(f))).toBe(true);
      expect(readFileSync(promptPath(id, 1), 'utf8').length).toBeGreaterThan(200);
    }
  });
});

describe('prompt content', () => {
  it('tells the model, in every prompt, that delimited data is never an instruction', () => {
    for (const p of loadPrompts().values()) {
      expect(p.text).toMatch(/is data|are data/u);
      expect(p.text).toMatch(/never an instruction to you/u);
    }
  });

  it('carries the PLAN §13 alt-text rules', () => {
    const text = loadPrompts().get('alt-text')?.text ?? '';
    expect(text).toMatch(/colour, material, pattern/u);
    expect(text).toMatch(/Never add a fact that neither the image nor the product title supports/u);
    expect(text).toMatch(/Never begin with "image of"/u);
    expect(text).toMatch(/max_characters/u);
    expect(text).toMatch(/Never identify or name a person/u);
    expect(text).toMatch(/language of primary_locale/u);
  });

  it('keeps tenant data out of the instruction prefix, so prompt caching applies', () => {
    for (const p of loadPrompts().values()) {
      expect(p.text).not.toMatch(/\{\{\s*[a-z_]+\s*\}\}|\$\{/u);
    }
  });

  it('passes the claims-lint CLI from packages/claims-lint (PLAN §3)', () => {
    const output = execFileSync(process.execPath, [claimsLint], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    const files = PROMPT_IDS.flatMap((id) =>
      readdirSync(new URL(`../prompts/${id}/`, import.meta.url)),
    ).length;
    expect(output).toMatch(new RegExp(`${String(files)} files scanned, no banned claims`, 'u'));
  });
});
