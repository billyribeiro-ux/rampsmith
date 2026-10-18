/**
 * One or more valid inputs for every email kind. Every value is invented test data on reserved
 * `.example` domains; the tokens and codes are not credentials for anything.
 */
import type { EmailInput, EmailKind, EmailSettings } from '../src/index.ts';

export const SETTINGS: EmailSettings = {
  appOrigin: 'https://app.rampsmith.example',
  siteOrigin: 'https://rampsmith.example',
  supportAddress: 'support@rampsmith.example',
  postalAddress: '100 Example Street\nSpringfield, EX 00000\nUnited States (test fixture)',
};

const APP = SETTINGS.appOrigin;
export const SITE = SETTINGS.siteOrigin;
const ADMIN = 'https://admin.shopify.com/store/fixture-store/apps/rampsmith';

/** Stands in for a sign-in token; long and unique so every occurrence can be found. */
export const SIGN_IN_TOKEN = 'TESTONLYtok9f8e7d6c5b4a39281706aa';
export const VERIFY_TOKEN = 'TESTONLYver1a2b3c4d5e6f7a8b9c0dd';
export const LINK_CODE = 'TEST-K7QX-M2PL';
export const UNSUBSCRIBE_TOKEN = 'TESTONLYunsub55aa66bb77cc88dd99';

const subscription = {
  unsubscribeUrl: `${APP}/email/unsubscribe?t=${UNSUBSCRIBE_TOKEN}`,
  preferencesUrl: `${APP}/settings/email`,
} as const;

const store = 'Example Outfitters';

type Fixtures = { readonly [K in EmailKind]: readonly (readonly [string, EmailInput<K>])[] };

export const FIXTURES: Fixtures = {
  sign_in_link: [
    ['default', { signInUrl: `${APP}/sign-in/link?token=${SIGN_IN_TOKEN}`, expiresInMinutes: 15 }],
  ],
  email_verification: [
    ['default', { verifyUrl: `${APP}/account/verify?token=${VERIFY_TOKEN}`, expiresInMinutes: 60 }],
  ],
  delivery_test: [['default', { requestedAt: '2026-10-17T21:05:00Z' }]],
  scanner_confirm: [
    [
      'default',
      {
        confirmUrl: `${SITE}/scan/confirm?c=TESTONLYconfirm0011`,
        expiresInHours: 24,
      },
    ],
  ],
  scanner_report: [
    [
      'default',
      {
        scannedHost: 'shop.example',
        scannedAt: '2026-10-17T20:00:00Z',
        pagesChecked: 3,
        checks: { passed: 41, total: 50 },
        issues: { critical: 2, serious: 7, moderate: 4, minor: 1 },
        topIssues: [
          { title: 'Images without alternative text', count: 12 },
          { title: 'Links without an accessible name', count: 5 },
          { title: 'Text with low colour contrast', count: 1 },
        ],
        reportUrl: `${SITE}/scan/report/TESTONLYreport0022`,
        reportExpiresAt: '2026-11-16T20:00:00Z',
        learnMoreUrl: `${SITE}/how-it-works`,
        unsubscribeUrl: `${SITE}/email/unsubscribe?t=${UNSUBSCRIBE_TOKEN}`,
      },
    ],
    [
      'no-top-issues',
      {
        scannedHost: 'xn--bcher-kva.example',
        scannedAt: '2026-10-17T20:00:00Z',
        pagesChecked: 1,
        checks: { passed: 50, total: 50 },
        issues: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        topIssues: [],
        reportUrl: `${SITE}/scan/report/TESTONLYreport0033`,
        reportExpiresAt: '2026-11-16T20:00:00Z',
        unsubscribeUrl: `${SITE}/email/unsubscribe?t=${UNSUBSCRIBE_TOKEN}`,
      },
    ],
  ],
  welcome: [['default', { ...subscription, storeName: store, appUrl: ADMIN }]],
  first_scan_complete: [
    [
      'default',
      {
        ...subscription,
        storeName: store,
        completedAt: '2026-10-17T18:30:00Z',
        pagesChecked: 24,
        checks: { passed: 37, total: 50 },
        issues: { critical: 3, serious: 9, moderate: 14, minor: 6 },
        fixesReady: 18,
        findingsUrl: `${ADMIN}/findings`,
      },
    ],
    [
      'no-fixes',
      {
        ...subscription,
        storeName: store,
        completedAt: '2026-10-17T18:30:00Z',
        pagesChecked: 1,
        checks: { passed: 50, total: 50 },
        issues: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        fixesReady: 0,
        findingsUrl: `${ADMIN}/findings`,
        locale: 'en-GB',
        timeZone: 'Europe/London',
      },
    ],
  ],
  weekly_summary: [
    [
      'default',
      {
        ...subscription,
        storeName: store,
        periodEnd: '2026-10-17T23:59:59Z',
        checks: { passed: 44, total: 50 },
        previousChecks: { passed: 41, total: 50 },
        newIssues: 2,
        resolvedIssues: 7,
        openIssues: { critical: 0, serious: 3, moderate: 5, minor: 2 },
        fixesAwaitingApproval: 4,
        nextScanAt: '2026-10-24T06:00:00Z',
        dashboardUrl: ADMIN,
      },
    ],
  ],
  regression_alert: [
    [
      'theme',
      {
        ...subscription,
        storeName: store,
        detectedAt: '2026-10-17T07:15:00Z',
        issues: [
          { title: 'Button without an accessible name', criterion: '4.1.2', impact: 'critical' },
          { title: 'Form field without a label', criterion: '1.3.1', impact: 'serious' },
        ],
        moreIssues: 3,
        cause: 'theme_published',
        causeLabel: 'Dawn copy, autumn sale',
        findingsUrl: `${ADMIN}/findings?filter=new`,
      },
    ],
    [
      'unknown-cause',
      {
        ...subscription,
        storeName: store,
        detectedAt: '2026-10-17T07:15:00Z',
        issues: [
          { title: 'Image without alternative text', criterion: '1.1.1', impact: 'serious' },
        ],
        moreIssues: 0,
        cause: 'unknown',
        findingsUrl: `${ADMIN}/findings?filter=new`,
      },
    ],
  ],
  barrier_report_received: [
    [
      'default',
      {
        ...subscription,
        storeName: store,
        receivedAt: '2026-10-17T12:00:00Z',
        reportsUrl: `${ADMIN}/reports`,
      },
    ],
  ],
  fix_approved: [
    [
      'default',
      {
        ...subscription,
        storeName: store,
        approvedAt: '2026-10-17T10:00:00Z',
        fixes: [
          { title: 'Add alt text to 12 product images', criterion: '1.1.1', channel: 'data' },
          { title: 'Name the cart icon link', criterion: '2.4.4', channel: 'pull_request' },
        ],
        moreFixes: 4,
        fixesUrl: `${ADMIN}/fixes`,
      },
    ],
  ],
  fix_verified: [
    [
      'all-verified',
      {
        ...subscription,
        storeName: store,
        verifiedAt: '2026-10-17T11:00:00Z',
        verified: [{ title: 'Add alt text to 12 product images', criterion: '1.1.1' }],
        moreVerified: 0,
        notVerified: [],
        moreNotVerified: 0,
        logUrl: `${ADMIN}/log`,
      },
    ],
    [
      'some-failed',
      {
        ...subscription,
        storeName: store,
        verifiedAt: '2026-10-17T11:00:00Z',
        verified: [{ title: 'Add alt text to 12 product images', criterion: '1.1.1' }],
        moreVerified: 2,
        notVerified: [{ title: 'Name the cart icon link', criterion: '2.4.4' }],
        moreNotVerified: 0,
        logUrl: `${ADMIN}/log`,
      },
    ],
  ],
  plan_changed: [
    [
      'upgrade',
      {
        storeName: store,
        plan: 'growth',
        previousPlan: 'starter',
        effectiveAt: '2026-10-17T09:00:00Z',
        scanCadence: 'daily',
        altTextDrafts: { limit: 10_000, period: 'monthly' },
        planUrl: `${ADMIN}/plan`,
      },
    ],
    [
      'to-free',
      {
        storeName: store,
        plan: 'free',
        previousPlan: 'starter',
        effectiveAt: '2026-10-17T09:00:00Z',
        scanCadence: 'monthly',
        altTextDrafts: { limit: 25, period: 'lifetime' },
        planUrl: `${ADMIN}/plan`,
      },
    ],
  ],
  usage_limit: [
    [
      'approaching',
      {
        storeName: store,
        resource: 'alt_text_drafts',
        used: 1800,
        limit: 2000,
        state: 'approaching',
        resetsAt: '2026-11-01T00:00:00Z',
        planUrl: `${ADMIN}/plan`,
      },
    ],
    [
      'reached-lifetime',
      {
        storeName: store,
        resource: 'alt_text_drafts',
        used: 25,
        limit: 25,
        state: 'reached',
        planUrl: `${ADMIN}/plan`,
      },
    ],
  ],
  agency_invitation: [
    [
      'default',
      {
        organizationName: 'Northwind Studio',
        role: 'member',
        acceptUrl: `${APP}/invitations/TESTONLYinvite0044`,
        expiresAt: '2026-10-24T10:00:00Z',
      },
    ],
  ],
  store_link_code: [
    [
      'default',
      {
        storeName: store,
        code: LINK_CODE,
        expiresAt: '2026-10-18T10:00:00Z',
        enterCodeUrl: `${APP}/agency/link-store`,
      },
    ],
  ],
  store_linked: [
    [
      'default',
      {
        storeName: store,
        organizationName: 'Northwind Studio',
        linkedAt: '2026-10-17T10:30:00Z',
        manageUrl: `${ADMIN}/settings/agencies`,
      },
    ],
  ],
  data_deletion: [
    [
      'store',
      {
        scope: 'store',
        storeName: store,
        completedAt: '2026-10-19T00:00:00Z',
        billingRecordsKept: true,
      },
    ],
    [
      'account',
      { scope: 'account', completedAt: '2026-10-19T00:00:00Z', billingRecordsKept: false },
    ],
  ],
  uninstall_export: [
    [
      'default',
      {
        storeName: store,
        exportUrl: `${APP}/export/TESTONLYexport0055`,
        deleteAt: '2026-10-19T10:00:00Z',
      },
    ],
  ],
  incident_notice: [
    [
      'store',
      {
        storeName: store,
        confirmedAt: '2026-10-17T15:00:00Z',
        whatHappened:
          'A test fixture describes what happened.\n\nIt has two paragraphs, and this one has\na kept line break.',
        dataInvolved: 'Scan screenshots of storefront pages. No shopper data.',
        whatWeAreDoing: 'We revoked the affected keys and are reviewing access logs.',
        whatYouCanDo: 'Nothing is needed from you.',
        updatesUrl: `${SITE}/status`,
      },
    ],
    [
      'account',
      {
        confirmedAt: '2026-10-17T15:00:00Z',
        whatHappened: 'A test fixture describes what happened.',
        dataInvolved: 'Account email addresses.',
        whatWeAreDoing: 'We reset every session.',
      },
    ],
  ],
  subprocessor_change: [
    [
      'default',
      {
        effectiveAt: '2026-11-20T00:00:00Z',
        changes: [
          {
            change: 'added',
            name: 'Example Mail Co',
            purpose: 'transactional email',
            location: 'United States',
          },
          {
            change: 'removed',
            name: 'Old Example Host',
            purpose: 'hosting',
            location: 'European Union',
          },
        ],
        objectBy: '2026-11-13T00:00:00Z',
        listUrl: `${SITE}/legal/subprocessors`,
      },
    ],
  ],
};

/** Every fixture as `[kind, name, input]`. */
export function allFixtures(): [EmailKind, string, unknown][] {
  return (Object.keys(FIXTURES) as EmailKind[]).flatMap((kind) =>
    FIXTURES[kind].map(([name, input]): [EmailKind, string, unknown] => [kind, name, input]),
  );
}

/** The input of fixture `index` of `kind`. */
export function fixture<K extends EmailKind>(kind: K, index = 0): EmailInput<K> {
  const entry = FIXTURES[kind][index];
  if (entry === undefined) {
    throw new Error(`no fixture ${String(index)} for ${kind}`);
  }
  return entry[1];
}
