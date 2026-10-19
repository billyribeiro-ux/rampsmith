import { describe, expect, it } from 'vitest';
import { applyAllowlist, parseAllowlist } from '../src/allowlist.ts';
import type { Violation } from '../src/scan.ts';

const violation = (over: Partial<Violation> = {}): Violation => ({
  file: 'apps/web/messages/en.json',
  line: 3,
  column: 12,
  rule: 'guarantee',
  match: 'guarantee',
  lineText: '  "terms_disclaimer": "Rampsmith does not guarantee any legal outcome."',
  message: 'm',
  ...over,
});

describe('parseAllowlist', () => {
  it('accepts well-formed entries', () => {
    const entries = parseAllowlist({
      entries: [
        {
          file: 'apps/web/messages/en.json',
          rule: 'guarantee',
          text: 'does not guarantee',
          reason: 'Terms disclaimer reviewed by counsel',
        },
      ],
    });
    expect(entries).toHaveLength(1);
  });

  it.each([
    [{}, /entries/],
    [{ entries: [{ file: 'a', rule: 'guarantee', text: 'x' }] }, /reason/],
    [
      { entries: [{ file: 'a', rule: 'nope', text: 'x', reason: 'long enough reason' }] },
      /unknown rule/,
    ],
    [
      { entries: [{ file: 'a', rule: 'guarantee', text: '', reason: 'long enough reason' }] },
      /text/,
    ],
    [{ entries: [{ file: 'a', rule: 'guarantee', text: 'x', reason: 'short' }] }, /reason/],
  ])('rejects malformed input %#', (input, error) => {
    expect(() => parseAllowlist(input)).toThrow(error);
  });
});

describe('applyAllowlist', () => {
  const entries = parseAllowlist({
    entries: [
      {
        file: 'apps/web/messages/en.json',
        rule: 'guarantee',
        text: 'does not guarantee',
        reason: 'Terms disclaimer reviewed by counsel',
      },
    ],
  });

  it('removes a violation whose file, rule and line text match an entry', () => {
    const result = applyAllowlist([violation()], entries);
    expect(result.violations).toEqual([]);
    expect(result.unused).toEqual([]);
  });

  it('keeps violations in other files or for other rules', () => {
    const other = [
      violation({ file: 'apps/web/messages/de.json' }),
      violation({ rule: 'certified' }),
    ];
    const result = applyAllowlist(other, entries);
    expect(result.violations).toHaveLength(2);
    expect(result.unused).toHaveLength(1);
  });

  it('reports entries that matched nothing', () => {
    const result = applyAllowlist([], entries);
    expect(result.unused).toEqual(entries);
  });
});
