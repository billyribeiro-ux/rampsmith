import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdits, mapOffset, spliceEdits, type Edit } from '../src/edits.ts';

const F = 'snippets/x.liquid';

function edit(start: number, end: number, replacement: string, file = F): Edit {
  return { file, start, end, replacement };
}

describe('spliceEdits', () => {
  it('applies edits regardless of the order they are given in', () => {
    const source = 'abcdef';
    const edits = [edit(1, 2, 'B'), edit(4, 4, '+'), edit(5, 6, '')];
    expect(spliceEdits(source, edits)).toEqual({ ok: true, contents: 'aBcd+e' });
    expect(spliceEdits(source, [...edits].reverse())).toEqual({ ok: true, contents: 'aBcd+e' });
  });

  it('returns the source unchanged when there are no edits', () => {
    expect(spliceEdits('abc', [])).toEqual({ ok: true, contents: 'abc' });
  });

  it('places an insertion before a replacement that starts at the same offset', () => {
    expect(spliceEdits('abcd', [edit(1, 3, 'X'), edit(1, 1, '+')])).toEqual({
      ok: true,
      contents: 'a+Xd',
    });
  });

  it('places an insertion after a replacement that ends at its offset', () => {
    expect(spliceEdits('abcd', [edit(3, 3, '+'), edit(1, 3, 'X')])).toEqual({
      ok: true,
      contents: 'aX+d',
    });
  });

  it('accepts insertions at offset 0 and at the end of the file', () => {
    expect(spliceEdits('ab', [edit(0, 0, '<'), edit(2, 2, '>')])).toEqual({
      ok: true,
      contents: '<ab>',
    });
  });

  it('rejects two insertions at the same offset as overlapping', () => {
    const result = spliceEdits('abcd', [edit(2, 2, 'x'), edit(2, 2, 'y')]);
    expect(result).toMatchObject({ ok: false, error: { code: 'overlap' } });
  });

  it('rejects overlapping replacements and an insertion inside a replaced span', () => {
    expect(spliceEdits('abcdef', [edit(1, 4, 'x'), edit(3, 5, 'y')])).toMatchObject({
      ok: false,
      error: { code: 'overlap' },
    });
    expect(spliceEdits('abcdef', [edit(1, 4, 'x'), edit(2, 2, 'y')])).toMatchObject({
      ok: false,
      error: { code: 'overlap' },
    });
    // A long edit that covers a later, non-adjacent one.
    expect(
      spliceEdits('abcdef', [edit(0, 6, 'x'), edit(1, 2, 'y'), edit(4, 5, 'z')]),
    ).toMatchObject({ ok: false, error: { code: 'overlap' } });
  });

  it('rejects offsets that are not integers, are negative, are reversed or are past the end', () => {
    expect(spliceEdits('abc', [edit(1.5, 2, '')])).toMatchObject({
      ok: false,
      error: { code: 'invalid-offset' },
    });
    expect(spliceEdits('abc', [edit(-1, 2, '')])).toMatchObject({
      ok: false,
      error: { code: 'invalid-offset' },
    });
    expect(spliceEdits('abc', [edit(2, 1, '')])).toMatchObject({
      ok: false,
      error: { code: 'invalid-offset' },
    });
    expect(spliceEdits('abc', [edit(2, 4, '')])).toMatchObject({
      ok: false,
      error: { code: 'out-of-bounds' },
    });
    expect(spliceEdits('abc', [edit(Number.NaN, 1, '')])).toMatchObject({
      ok: false,
      error: { code: 'invalid-offset' },
    });
  });

  it('rejects an offset that splits a surrogate pair and a replacement with a lone surrogate', () => {
    const source = 'a\u{1F600}b'; // the emoji is two UTF-16 code units, at indexes 1 and 2
    expect(spliceEdits(source, [edit(2, 2, 'x')])).toMatchObject({
      ok: false,
      error: { code: 'splits-surrogate-pair' },
    });
    expect(spliceEdits(source, [edit(3, 3, 'x')])).toEqual({ ok: true, contents: 'a\u{1F600}xb' });
    expect(spliceEdits('ab', [edit(1, 1, '\uD800')])).toMatchObject({
      ok: false,
      error: { code: 'invalid-replacement' },
    });
  });

  it('rejects edits for different files in one call', () => {
    expect(spliceEdits('abc', [edit(0, 0, 'x'), edit(1, 1, 'y', 'other.liquid')])).toMatchObject({
      ok: false,
      error: { code: 'file-mismatch' },
    });
  });
});

/**
 * Non-overlapping edits over `source`, in shuffled order. Spans may touch (an insertion right
 * before or after a replacement), but two insertions never share an offset.
 */
function disjointEdits(source: string): fc.Arbitrary<Edit[]> {
  return fc
    .array(fc.integer({ min: 0, max: source.length }), { maxLength: 10 })
    .chain((cuts) => {
      const points = [...cuts].sort((a, b) => a - b);
      const spans: [number, number][] = [];
      for (let i = 0; i + 1 < points.length; i += 2) {
        const start = points[i] ?? 0;
        const end = points[i + 1] ?? start;
        spans.push([start, end]);
      }
      return fc.tuple(
        ...spans.map(([start, end]) =>
          fc
            .tuple(fc.boolean(), fc.string({ maxLength: 6 }))
            .map(([insert, replacement]) => edit(start, insert ? start : end, replacement)),
        ),
      );
    })
    .map((edits) => {
      const insertions = new Set<number>();
      return edits.filter((e) => {
        if (e.start !== e.end) return true;
        if (insertions.has(e.start)) return false;
        insertions.add(e.start);
        return true;
      });
    })
    .chain((edits) => fc.shuffledSubarray(edits, { minLength: edits.length }));
}

describe('spliceEdits properties', () => {
  it('keeps every byte outside the edited spans identical', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'binary-ascii', maxLength: 60 })
          .chain((source) => fc.tuple(fc.constant(source), disjointEdits(source))),
        ([source, edits]) => {
          const result = spliceEdits(source, edits);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // Walk the edits in order: the gaps between them must appear verbatim, in order.
          const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
          let cursor = 0;
          let out = 0;
          for (const e of sorted) {
            const gap = source.slice(cursor, e.start);
            expect(result.contents.slice(out, out + gap.length)).toBe(gap);
            out += gap.length;
            expect(result.contents.slice(out, out + e.replacement.length)).toBe(e.replacement);
            out += e.replacement.length;
            cursor = e.end;
          }
          expect(result.contents.slice(out)).toBe(source.slice(cursor));
        },
      ),
    );
  });

  it('maps every untouched offset to the same character in the result', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'binary-ascii', minLength: 1, maxLength: 60 })
          .chain((source) =>
            fc.tuple(
              fc.constant(source),
              disjointEdits(source),
              fc.nat({ max: source.length - 1 }),
            ),
          ),
        ([source, edits, offset]) => {
          const result = spliceEdits(source, edits);
          if (!result.ok) return;
          const mapped = mapOffset(offset, edits);
          const touched = edits.some((e) => e.start <= offset && offset < e.end);
          if (touched) {
            expect(mapped).toBeNull();
          } else {
            expect(mapped).not.toBeNull();
            expect(result.contents[mapped ?? -1]).toBe(source[offset]);
          }
        },
      ),
    );
  });
});

describe('applyEdits', () => {
  it('applies span edits to a Liquid file and re-parses the result', () => {
    const source = '<div class="a">{{ x }}</div>\n';
    const result = applyEdits(source, [edit(14, 14, ' id="b"')]);
    expect(result).toEqual({ ok: true, contents: '<div class="a" id="b">{{ x }}</div>\n' });
  });

  it('rejects a result that no longer parses', () => {
    const source = '<div class="a"></div>';
    const result = applyEdits(source, [edit(15, 15, '<span>')]);
    expect(result).toMatchObject({ ok: false, error: { code: 'result-unparseable' } });
  });

  it('rejects a result that adds Liquid the parser cannot read strictly', () => {
    const source = '<p>{{ x }}</p>';
    expect(applyEdits(source, [edit(10, 10, '{{ y | | }}')])).toMatchObject({
      ok: false,
      error: { code: 'unparsed-liquid-added' },
    });
    expect(applyEdits(source, [edit(10, 10, '{% render %}')])).toMatchObject({
      ok: false,
      error: { code: 'unparsed-liquid-added' },
    });
  });

  it('rejects edits to a source that does not parse', () => {
    expect(applyEdits('<div>', [edit(0, 0, 'x')])).toMatchObject({
      ok: false,
      error: { code: 'source-unparseable' },
    });
  });

  it('validates JSON files as JSON with comments and no trailing commas', () => {
    const file = 'locales/en.default.json';
    const source = '/* header */\n{ "a": "b" }\n';
    expect(applyEdits(source, [edit(23, 23, ', "c": "d"', file)])).toEqual({
      ok: true,
      contents: '/* header */\n{ "a": "b", "c": "d" }\n',
    });
    expect(applyEdits(source, [edit(23, 23, ',', file)])).toMatchObject({
      ok: false,
      error: { code: 'result-unparseable' },
    });
  });

  it('rejects edits to a JSON file that is already invalid', () => {
    expect(applyEdits('{"a": ', [edit(0, 0, ' ', 'locales/en.default.json')])).toMatchObject({
      ok: false,
      error: { code: 'source-unparseable' },
    });
  });

  it('refuses file types it cannot validate', () => {
    expect(applyEdits('<svg/>', [edit(0, 0, 'x', 'assets/icon.svg')])).toMatchObject({
      ok: false,
      error: { code: 'unsupported-file' },
    });
  });

  it('keeps a CSS file parseable: a value edit passes, a broken block is refused', () => {
    const file = 'assets/base.css';
    const source = '.a { color: #aaa; }\n';
    expect(applyEdits(source, [edit(12, 16, '#767676', file)])).toEqual({
      ok: true,
      contents: '.a { color: #767676; }\n',
    });
    expect(applyEdits(source, [edit(0, 0, '/* note */ ', file)])).toMatchObject({ ok: true });
    expect(applyEdits(source, [edit(17, 19, ' ', file)])).toMatchObject({
      ok: false,
      error: { code: 'result-unparseable' },
    });
    expect(applyEdits('.a { color: ', [edit(0, 0, ' ', file)])).toMatchObject({
      ok: false,
      error: { code: 'source-unparseable' },
    });
  });

  it('returns the source when there are no edits', () => {
    expect(applyEdits('<div>', [])).toEqual({ ok: true, contents: '<div>' });
  });
});
