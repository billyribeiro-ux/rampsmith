import { describe, expect, it } from 'vitest';
import {
  renderStatement,
  ReportInputError,
  statementStatus,
  type StatementInput,
} from '../src/index.ts';
import { statementInput } from './fixtures.ts';

const succeeded = {
  status: 'succeeded',
  finishedAt: new Date('2026-10-16T00:00:00Z'),
  pagesChecked: 10,
  checksRun: 100,
  checksPassed: 100,
} as const;

describe('statementStatus', () => {
  it('is not_evaluated without a scan, or when the scan has no results', () => {
    expect(statementStatus({ findings: [] })).toBe('not_evaluated');
    for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) {
      expect(statementStatus({ latestScan: { ...succeeded, status }, findings: [] })).toBe(
        'not_evaluated',
      );
    }
  });

  it('is known_barriers when an open or accepted-risk finding exists', () => {
    expect(statementStatus({ latestScan: succeeded, findings: [{ status: 'open' }] })).toBe(
      'known_barriers',
    );
    expect(
      statementStatus({ latestScan: succeeded, findings: [{ status: 'accepted_risk' }] }),
    ).toBe('known_barriers');
  });

  it('is known_barriers when checks failed or the merchant lists a limitation', () => {
    expect(statementStatus({ latestScan: { ...succeeded, checksPassed: 99 }, findings: [] })).toBe(
      'known_barriers',
    );
    expect(statementStatus({ latestScan: succeeded, findings: [], limitations: [{}] })).toBe(
      'known_barriers',
    );
  });

  it('is no_known_barriers only when nothing failed, ignoring fixed and dismissed findings', () => {
    expect(
      statementStatus({
        latestScan: { ...succeeded, status: 'partial' },
        findings: [{ status: 'fixed' }, { status: 'false_positive' }, { status: 'needs_review' }],
      }),
    ).toBe('no_known_barriers');
  });
});

describe('renderStatement', () => {
  it('renders the fixture as known barriers, merging findings that read the same', () => {
    const out = renderStatement(statementInput());
    expect(out.status).toBe('known_barriers');
    expect(out.text).toContain(
      'Some product images have no text alternative. WCAG 2.2 success criterion: 1.1.1. Found in 21 places in the latest scan.',
    );
    expect(out.text).not.toContain('reported but is not a failure');
    // Most severe first.
    expect(out.text.indexOf('traps keyboard focus')).toBeLessThan(
      out.text.indexOf('no text alternative'),
    );
  });

  it('says what the scan found and what automated checks cannot show', () => {
    const out = renderStatement(statementInput());
    expect(out.text).toContain(
      'In the scan on October 16, 2026, Example Goods passed 1,198 of 1,250 automated WCAG 2.2 Level AA checks.',
    );
    expect(out.text).toContain('finds on average 57% of WCAG issues');
    expect(out.text).toContain('Not tested by automated checks; a person must check: 30 criteria');
  });

  it('never claims the standard is met in full when nothing failed', () => {
    const out = renderStatement(
      statementInput({
        latestScan: { ...succeeded, checksRun: 50, checksPassed: 50 },
        findings: [],
        limitations: [],
      }),
    );
    expect(out.status).toBe('no_known_barriers');
    expect(out.text).toContain('this does not show that Example Goods meets the standard in full');
    expect(out.text).not.toMatch(/fully|meets WCAG 2\.2 Level AA\b/u);
  });

  it('says plainly when nothing has been evaluated yet', () => {
    const input: { latestScan?: unknown } & StatementInput = statementInput({
      findings: [],
      limitations: [],
    });
    delete input.latestScan;
    const out = renderStatement(input);
    expect(out.status).toBe('not_evaluated');
    expect(out.text).toContain(
      'We have not yet evaluated Example Goods against WCAG 2.2 Level AA.',
    );
    expect(out.text).toContain('No evaluation has been completed yet.');
    expect(out.text).not.toContain('passed');
  });

  it('notes a partial scan', () => {
    const out = renderStatement(
      statementInput({ latestScan: { ...succeeded, status: 'partial', checksPassed: 90 } }),
    );
    expect(out.text).toContain('Some pages could not be checked in that scan');
  });

  it('counts the barriers beyond the first fifty instead of listing them', () => {
    const findings = Array.from({ length: 53 }, (_, i) => ({
      summary: `Barrier number ${String(i)}.`,
      criteria: ['1.1.1'],
      impact: 'minor' as const,
      status: 'open' as const,
      occurrences: 1,
    }));
    const out = renderStatement(statementInput({ findings, limitations: [] }));
    expect(out.text).toContain('Barrier number 9.');
    expect(out.text).toContain(
      '3 more barriers found by the automated checks are not listed here.',
    );
  });

  it('falls back to English for a locale without a catalog, and reports it', () => {
    const out = renderStatement(statementInput({ locale: 'de-DE' }));
    expect(out.locale).toBe('en');
    expect(out.fallback).toBe(true);
    expect(out.document.html).toContain('<html lang="en">');
  });

  it('publishes a fragment without the document title, starting at h2', () => {
    const out = renderStatement(statementInput());
    expect(out.fragment.startsWith('<p>Example Goods Ltd wants everyone')).toBe(true);
    expect(out.fragment).not.toContain('<h1>');
    expect(out.fragment).toContain('<h2>Status against WCAG 2.2 Level AA</h2>');
    expect(out.document.html).toContain('<h1>Accessibility statement for Example Goods</h1>');
  });

  it('links each contact route, with tel and mailto targets built from validated input', () => {
    const out = renderStatement(statementInput());
    expect(out.fragment).toContain(
      'Email: <a href="mailto:access@example-goods.example">access@example-goods.example</a>',
    );
    expect(out.fragment).toContain('Phone: <a href="tel:+15550100199">+1 555 010 0199</a>');
    expect(out.fragment).toContain('Post: 1 Example Street, Example City');
    expect(out.fragment).toContain(
      'Online form: <a href="https://example-goods.example/pages/report-a-barrier">report a barrier</a>',
    );
    expect(out.text).toContain(
      'Online form: report a barrier (https://example-goods.example/pages/report-a-barrier)',
    );
  });
});

describe('renderStatement refuses inputs it cannot state honestly', () => {
  it.each([
    [{ organization: '  ' }, 'organization'],
    [{ site: { name: 'X', url: 'javascript:alert(1)', platform: 'shopify' as const } }, 'site.url'],
    [{ contact: {} }, 'contact'],
    [{ contact: { email: 'not an email' } }, 'contact.email'],
    [{ contact: { phone: 'call us maybe' } }, 'contact.phone'],
    [{ contact: { formUrl: 'file:///etc/passwd' } }, 'contact.formUrl'],
    [{ complaints: { description: 'x', url: 'data:text/html,hi' } }, 'complaints.url'],
    [{ preparedAt: new Date('nope') }, 'preparedAt'],
    [{ latestScan: { ...succeeded, checksPassed: 101 } }, 'latestScan.checksPassed'],
    [{ latestScan: { ...succeeded, pagesChecked: -1 } }, 'latestScan.pagesChecked'],
    [
      { coverage: { automated: ['1.4.6'], partial: [], rulesetVersion: 'v' } },
      'coverage.automated',
    ],
    [
      {
        findings: [
          {
            summary: 'x',
            criteria: ['9.9.9'],
            impact: 'minor' as const,
            status: 'open' as const,
            occurrences: 1,
          },
        ],
      },
      'findings[0].criteria',
    ],
    [{ organization: 'x'.repeat(201) }, 'organization'],
    [{ organization: 'two\nlines' }, 'organization'],
  ])('%#: refuses a bad %s', (override, field) => {
    let error: unknown;
    try {
      renderStatement(statementInput(override));
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReportInputError);
    expect((error as ReportInputError).field).toBe(field);
  });
});
