// Synthetic inputs for the report tests. Every name, address and identifier is invented.
import type {
  CoverageInput,
  RemediationLogInput,
  StatementInput,
  SummaryInput,
} from '../src/index.ts';

const COVERAGE: CoverageInput = {
  automated: [],
  partial: [
    '1.1.1',
    '1.2.2',
    '1.3.1',
    '1.3.5',
    '1.4.1',
    '1.4.2',
    '1.4.3',
    '1.4.4',
    '1.4.10',
    '1.4.12',
    '2.1.1',
    '2.1.2',
    '2.2.1',
    '2.2.2',
    '2.4.1',
    '2.4.2',
    '2.4.4',
    '2.4.7',
    '2.4.11',
    '2.5.3',
    '2.5.8',
    '3.1.1',
    '3.1.2',
    '3.3.2',
    '4.1.2',
  ],
  rulesetVersion: 'axe-core 4.14.0 + rampsmith-rules 0f3c9a1',
  reviewQueue: 3,
};

const SITE = {
  name: 'Example Goods',
  url: 'https://example-goods.example',
  platform: 'shopify',
} as const;

export function statementInput(overrides: Partial<StatementInput> = {}): StatementInput {
  return {
    locale: 'en',
    organization: 'Example Goods Ltd',
    site: SITE,
    preparedAt: new Date('2026-10-17T12:00:00Z'),
    reviewedAt: new Date('2026-10-18T09:00:00Z'),
    scanFrequency: 'weekly',
    latestScan: {
      status: 'succeeded',
      finishedAt: new Date('2026-10-16T03:12:00Z'),
      pagesChecked: 42,
      checksRun: 1_250,
      checksPassed: 1_198,
    },
    findings: [
      {
        summary: 'Some product images have no text alternative.',
        criteria: ['1.1.1'],
        impact: 'serious',
        status: 'open',
        occurrences: 17,
      },
      {
        summary: 'The cart drawer traps keyboard focus.',
        criteria: ['2.1.2'],
        impact: 'critical',
        status: 'open',
        occurrences: 1,
      },
      {
        summary: 'Some links do not say where they go.',
        criteria: ['2.4.4'],
        impact: 'moderate',
        status: 'accepted_risk',
        occurrences: 3,
      },
      {
        summary: 'A colour pairing in the footer was reported but is not a failure.',
        criteria: ['1.4.3'],
        impact: 'serious',
        status: 'false_positive',
        occurrences: 5,
      },
      {
        summary: 'Some product images have no text alternative.',
        criteria: ['1.1.1'],
        impact: 'serious',
        status: 'open',
        occurrences: 4,
      },
    ],
    coverage: COVERAGE,
    verifiedFixes: { count: 128, since: new Date('2026-09-01T00:00:00Z') },
    measures: ['Our staff check new product pages with a keyboard before they go live.'],
    limitations: [
      {
        description: 'Older size guides are PDF files without tags.',
        reason: 'They were made before we started this work.',
        alternative: 'Email us and we will send the size guide as text.',
        plannedFixBy: new Date('2026-12-31T00:00:00Z'),
      },
    ],
    contact: {
      email: 'access@example-goods.example',
      phone: '+1 555 010 0199',
      postalAddress: '1 Example Street\nExample City',
      formUrl: 'https://example-goods.example/pages/report-a-barrier',
      responseTime: '5 business days',
    },
    compatibility: 'We test with current versions of Chrome, Firefox and Safari.',
    otherEvaluations: [
      {
        description: 'Our team tested checkout-free pages with NVDA and VoiceOver.',
        date: new Date('2026-10-10T00:00:00Z'),
      },
    ],
    complaints: {
      description:
        'If our reply does not resolve the problem, you can contact the consumer authority in your country.',
      url: 'https://consumer-authority.example/accessibility',
    },
    ...overrides,
  };
}

export function remediationInput(
  overrides: Partial<RemediationLogInput> = {},
): RemediationLogInput {
  return {
    locale: 'en',
    site: SITE,
    generatedAt: new Date('2026-10-18T10:00:00Z'),
    entries: [
      {
        fixId: '01920000-0000-7000-8000-000000000001',
        kind: 'data',
        channel: 'admin_api',
        origin: 'ai',
        model: 'claude-haiku-5-5',
        status: 'verified',
        proposedAt: new Date('2026-10-01T10:00:00Z'),
        approvedAt: new Date('2026-10-01T11:00:00Z'),
        approver: { kind: 'user', name: 'Approver A' },
        appliedAt: new Date('2026-10-01T11:00:05Z'),
        change: {
          kind: 'data',
          resource: 'gid://shopify/MediaImage/1001',
          field: 'alt',
          before: 'IMG_0042.jpg',
          after: 'Blue linen shirt, front view',
        },
        verification: {
          scanId: '01920000-0000-7000-8000-0000000000a1',
          at: new Date('2026-10-02T03:00:00Z'),
        },
        findings: [
          {
            findingId: '01920000-0000-7000-8000-0000000000f1',
            ruleId: 'rs-media-alt-filename',
            criteria: ['1.1.1'],
            impact: 'serious',
            summary: 'A product image uses a file name as its alt text.',
          },
        ],
      },
      {
        fixId: '01920000-0000-7000-8000-000000000002',
        kind: 'code',
        channel: 'github_pr',
        origin: 'rule',
        status: 'applied',
        proposedAt: new Date('2026-10-05T08:00:00Z'),
        approvedAt: new Date('2026-10-05T09:30:00Z'),
        approver: { kind: 'user', name: 'Approver B' },
        appliedAt: new Date('2026-10-06T14:00:00Z'),
        change: { kind: 'code', reference: 'https://github.com/example/theme/pull/7' },
        findings: [
          {
            findingId: '01920000-0000-7000-8000-0000000000f2',
            ruleId: 'button-name',
            criteria: ['4.1.2'],
            impact: 'critical',
            summary: 'The menu button has no accessible name.',
          },
          {
            findingId: '01920000-0000-7000-8000-0000000000f3',
            ruleId: 'rs-focus-indicator-missing',
            criteria: ['2.4.7'],
            impact: 'serious',
            summary: 'The menu button shows no focus indicator.',
          },
        ],
      },
      {
        fixId: '01920000-0000-7000-8000-000000000003',
        kind: 'data',
        channel: 'admin_api',
        origin: 'human',
        status: 'reverted',
        proposedAt: new Date('2026-10-07T08:00:00Z'),
        approvedAt: new Date('2026-10-07T08:05:00Z'),
        approver: { kind: 'user', name: 'Approver A' },
        appliedAt: new Date('2026-10-07T08:05:02Z'),
        change: {
          kind: 'data',
          resource: 'gid://shopify/Product/2002',
          field: 'descriptionHtml',
          before: '<p>Click here</p>',
          after: '<p>Read the care guide</p>',
        },
        findings: [
          {
            findingId: '01920000-0000-7000-8000-0000000000f4',
            ruleId: 'rs-rich-text-link-vague',
            criteria: ['2.4.4'],
            impact: 'moderate',
            summary: 'A link says "click here" and does not say where it goes.',
          },
        ],
      },
      {
        fixId: '01920000-0000-7000-8000-000000000004',
        kind: 'data',
        channel: 'admin_api',
        origin: 'rule',
        status: 'proposed',
        proposedAt: new Date('2026-10-08T08:00:00Z'),
        approvedAt: null,
        approver: null,
        appliedAt: null,
        change: {
          kind: 'data',
          resource: 'gid://shopify/MediaImage/1003',
          field: 'alt',
          before: '',
          after: 'Wool scarf in green',
        },
        reverts: '01920000-0000-7000-8000-000000000003',
        findings: [
          {
            findingId: '01920000-0000-7000-8000-0000000000f5',
            ruleId: 'rs-media-alt-empty',
            criteria: ['1.1.1'],
            impact: 'serious',
            summary: 'A product image has no alt text.',
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function summaryInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    locale: 'en',
    site: SITE,
    generatedAt: new Date('2026-10-18T10:00:00Z'),
    period: { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-17T00:00:00Z') },
    scans: [
      { finishedAt: new Date('2026-09-04T03:00:00Z'), checksRun: 1_180, checksPassed: 1_003 },
      { finishedAt: new Date('2026-09-11T03:00:00Z'), checksRun: 1_190, checksPassed: 1_071 },
      { finishedAt: new Date('2026-09-18T03:00:00Z'), checksRun: 1_200, checksPassed: 1_116 },
      { finishedAt: new Date('2026-09-25T03:00:00Z'), checksRun: 1_210, checksPassed: 1_150 },
      { finishedAt: new Date('2026-10-02T03:00:00Z'), checksRun: 1_230, checksPassed: 1_181 },
      { finishedAt: new Date('2026-10-09T03:00:00Z'), checksRun: 1_240, checksPassed: 1_178 },
      { finishedAt: new Date('2026-10-16T03:12:00Z'), checksRun: 1_250, checksPassed: 1_198 },
    ],
    openFindings: { critical: 1, serious: 6, moderate: 9, minor: 4 },
    fixes: { verified: 128, proposed: 5 },
    coverage: COVERAGE,
    ...overrides,
  };
}
