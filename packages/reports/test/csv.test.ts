import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/csv.ts';

describe('csvCell', () => {
  it('quotes every field and doubles embedded quotes (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi", then go')).toBe('"say ""hi"", then go"');
    expect(csvCell('')).toBe('""');
  });

  it('keeps line breaks inside the quoted field, normalized to LF', () => {
    expect(csvCell('line one\r\nline two\rthree')).toBe('"line one\nline two\nthree"');
  });

  it.each([
    ['=HYPERLINK("http://evil.example","x")', `"'=HYPERLINK(""http://evil.example"",""x"")"`],
    ['+1+cmd|calc', `"'+1+cmd|calc"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1:A2)', `"'@SUM(A1:A2)"`],
    ['\t=1+1', `"'\t=1+1"`],
    ['\r=1+1', `"'\n=1+1"`],
    ['  =1+1', `"'  =1+1"`],
    ['＝1+1', `"'＝1+1"`],
    ['＋1', `"'＋1"`],
    ['－1', `"'－1"`],
    ['＠x', `"'＠x"`],
  ])('neutralizes a formula trigger at the start: %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('does not touch a trigger character that is not at the start', () => {
    expect(csvCell('a=b+c-d@e')).toBe('"a=b+c-d@e"');
  });

  it('removes unsafe control characters', () => {
    expect(csvCell('a\u0000b\u202Ec')).toBe('"abc"');
  });
});

describe('toCsv', () => {
  it('writes a BOM, CRLF row endings and a final CRLF', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['1', '2'],
          ['x,y', '=z'],
        ],
      ),
    ).toBe('\uFEFF"a","b"\r\n"1","2"\r\n"x,y","\'=z"\r\n');
  });

  it('refuses a row whose width differs from the header', () => {
    expect(() => toCsv(['a', 'b'], [['only one']])).toThrow(/row 1 has 1 field/u);
  });
});
