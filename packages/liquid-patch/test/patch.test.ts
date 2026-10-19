import { applyPatch } from 'diff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/diff.ts';
import { buildPatch } from '../src/patch.ts';

describe('unifiedDiff', () => {
  it('produces the exact unified format with a/ and b/ prefixes', () => {
    const before = ['<html class="js">', '<head>', '  <title>x</title>', '</head>', ''].join('\n');
    const after = before.replace('class="js"', 'class="js" lang="{{ request.locale.iso_code }}"');
    expect(unifiedDiff('layout/theme.liquid', before, after)).toBe(
      [
        '--- a/layout/theme.liquid',
        '+++ b/layout/theme.liquid',
        '@@ -1,4 +1,4 @@',
        '-<html class="js">',
        '+<html class="js" lang="{{ request.locale.iso_code }}">',
        ' <head>',
        '   <title>x</title>',
        ' </head>',
        '',
      ].join('\n'),
    );
  });

  it('is empty when nothing changed', () => {
    expect(unifiedDiff('a.liquid', 'x\n', 'x\n')).toBe('');
  });

  it('marks a missing final newline the way git does', () => {
    expect(unifiedDiff('a.liquid', 'x', 'y')).toContain('\\ No newline at end of file');
  });

  it('is stable across runs and round-trips through a patch applier', () => {
    const line = fc
      .string({ unit: 'grapheme-ascii', maxLength: 12 })
      .filter((s) => !s.includes('\n'));
    const text = fc.array(line, { maxLength: 12 }).map((lines) => lines.join('\n'));
    fc.assert(
      fc.property(text, text, (before, after) => {
        const diff = unifiedDiff('snippets/a.liquid', before, after);
        expect(unifiedDiff('snippets/a.liquid', before, after)).toBe(diff);
        if (before === after) {
          expect(diff).toBe('');
          return;
        }
        expect(applyPatch(before, diff)).toBe(after);
      }),
    );
  });

  it('keeps CRLF line endings inside the hunk lines, as git diff does', () => {
    const file = 'snippets/card.liquid';
    const before = ['<div>', '  <img src="{{ x | image_url }}">', '</div>', ''].join('\r\n');
    const after = before.replace('<img ', '<img alt="" ');
    const diff = unifiedDiff(file, before, after);
    expect(diff).toBe(
      [
        '--- a/snippets/card.liquid',
        '+++ b/snippets/card.liquid',
        '@@ -1,3 +1,3 @@',
        ' <div>\r',
        '-  <img src="{{ x | image_url }}">\r',
        '+  <img alt="" src="{{ x | image_url }}">\r',
        ' </div>\r',
        '',
      ].join('\n'),
    );
    expect(applyPatch(before, diff)).toBe(after);
  });
});

describe('buildPatch', () => {
  const files = new Map([
    ['snippets/b.liquid', '<p>b</p>\n'],
    ['snippets/a.liquid', '<p>a</p>\n'],
  ]);

  it('returns patched contents and one diff per changed file, sorted by path', () => {
    const result = buildPatch(files, [
      { file: 'snippets/b.liquid', start: 2, end: 2, replacement: ' id="b"' },
      { file: 'snippets/a.liquid', start: 2, end: 2, replacement: ' id="a"' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches.map((p) => p.file)).toEqual(['snippets/a.liquid', 'snippets/b.liquid']);
    expect(result.patches[0]).toMatchObject({ before: '<p>a</p>\n', after: '<p id="a">a</p>\n' });
    expect(result.patches[0]?.diff).toContain('+<p id="a">a</p>');
  });

  it('leaves out files whose edits change nothing', () => {
    const result = buildPatch(files, [
      { file: 'snippets/a.liquid', start: 3, end: 4, replacement: 'a' },
    ]);
    expect(result).toEqual({ ok: true, patches: [] });
  });

  it('fails on a file it was not given', () => {
    const result = buildPatch(files, [
      { file: 'snippets/c.liquid', start: 0, end: 0, replacement: 'x' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { file: 'snippets/c.liquid', code: 'missing-file' },
    });
  });

  it('fails on the file whose edits break it', () => {
    const result = buildPatch(files, [
      { file: 'snippets/b.liquid', start: 3, end: 3, replacement: '<i>' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { file: 'snippets/b.liquid', code: 'result-unparseable' },
    });
  });
});
