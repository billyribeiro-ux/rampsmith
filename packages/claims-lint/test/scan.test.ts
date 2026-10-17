import { describe, expect, it } from 'vitest';
import { scanText } from '../src/scan.ts';

const ids = (text: string) => scanText('copy.txt', text).violations.map((v) => v.rule);

describe('banned claims (PLAN §3)', () => {
  it.each([
    ['Make your store ADA compliant today', 'compliance'],
    ['WCAG compliant in minutes', 'compliance'],
    ['Stay EAA-compliant', 'compliance'],
    ['Full accessibility compliance', 'compliance'],
    ['Your theme now conforms to WCAG 2.2', 'compliance'],
    ['Lawsuit-proof your storefront', 'lawsuit-proof'],
    ['Be lawsuit proof', 'lawsuit-proof'],
    ['Guaranteed results', 'guarantee'],
    ['We guarantee your store passes', 'guarantee'],
    ['Certified accessible', 'certified'],
    ['Accessibility certification included', 'certified'],
    ['Protects you from ADA lawsuits', 'legal-protection'],
    ['Protect your store against demand letters', 'legal-protection'],
    ['Built-in legal protection', 'legal-protection'],
    ['100% accessible storefront', 'absolute-accessibility'],
    ['Become fully accessible', 'absolute-accessibility'],
  ])('flags %j as %s', (text, rule) => {
    expect(ids(text)).toContain(rule);
  });

  it.each([
    'Passes 42 of 50 automated WCAG 2.2 AA checks',
    'Dated remediation record of fixes applied',
    'Barriers removed; issues automation cannot detect are listed',
    'Enter your storefront password if the store is password-protected',
    'Automated checks find only part of all accessibility issues',
    'Protect your API keys',
  ])('accepts honest copy: %j', (text) => {
    expect(ids(text)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(ids('GUARANTEED')).toEqual(['guarantee']);
  });

  it('reports the 1-based line and column of each match', () => {
    const { violations } = scanText('a.txt', 'first line\n  now certified');
    expect(violations).toEqual([
      expect.objectContaining({
        file: 'a.txt',
        line: 2,
        column: 7,
        rule: 'certified',
        match: 'certified',
      }),
    ]);
  });

  it('reports every match on a line', () => {
    expect(ids('guaranteed and certified')).toEqual(['guarantee', 'certified']);
  });
});

describe('allow markers', () => {
  it('suppresses a violation on the same line when the marker names the rule and a reason', () => {
    const text =
      'Rampsmith does not guarantee compliance. <!-- claims-lint-allow guarantee,compliance: Terms of Service disclaimer required by counsel -->';
    const result = scanText('terms.html', text);
    expect(result.violations).toEqual([]);
    expect(result.markerProblems).toEqual([]);
  });

  it('suppresses a violation on the line right after the marker', () => {
    const text = [
      '{/* claims-lint-allow guarantee: legal page must state the absence of any guarantee */}',
      '<p>No guarantee of any outcome is given.</p>',
    ].join('\n');
    expect(scanText('legal.svelte', text).violations).toEqual([]);
  });

  it('does not reach two lines down', () => {
    const text = '# claims-lint-allow guarantee: reason that is long enough\n\nGuaranteed!';
    const result = scanText('x.txt', text);
    expect(result.violations.map((v) => v.rule)).toEqual(['guarantee']);
    expect(result.markerProblems.map((p) => p.kind)).toEqual(['unused']);
  });

  it('only suppresses the rules it names', () => {
    const text =
      'certified and guaranteed <!-- claims-lint-allow guarantee: quoting the FTC order -->';
    expect(ids(text)).toEqual(['certified']);
  });

  it('rejects a marker without a reason', () => {
    const result = scanText('x.txt', 'guaranteed <!-- claims-lint-allow guarantee -->');
    expect(result.violations.map((v) => v.rule)).toEqual(['guarantee']);
    expect(result.markerProblems.map((p) => p.kind)).toEqual(['missing-reason']);
  });

  it('rejects a reason too short to explain anything', () => {
    const result = scanText('x.txt', 'guaranteed <!-- claims-lint-allow guarantee: ok -->');
    expect(result.markerProblems.map((p) => p.kind)).toEqual(['missing-reason']);
  });

  it('rejects a marker naming an unknown rule', () => {
    const result = scanText(
      'x.txt',
      'fine copy <!-- claims-lint-allow everything: because I said so -->',
    );
    expect(result.markerProblems.map((p) => p.kind)).toEqual(['unknown-rule']);
  });

  it('rejects a marker that suppresses nothing', () => {
    const result = scanText(
      'x.txt',
      'honest copy # claims-lint-allow guarantee: left over from an old draft',
    );
    expect(result.markerProblems.map((p) => p.kind)).toEqual(['unused']);
  });

  it('never treats the marker text itself as a violation', () => {
    const text =
      'No guarantee. # claims-lint-allow guarantee: disclaimer that mentions guaranteed outcomes';
    const result = scanText('x.txt', text);
    expect(result.violations).toEqual([]);
    expect(result.markerProblems).toEqual([]);
  });
});
