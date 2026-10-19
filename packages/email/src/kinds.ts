/** Every email Rampsmith sends, by kind. */
import type { InputOf } from './schema.ts';
import { deliveryTest, emailVerification, signInLink } from './templates/account.ts';
import { agencyInvitation, storeLinkCode, storeLinked } from './templates/agency.ts';
import { planChanged, usageLimit } from './templates/billing.ts';
import { fixApproved, fixVerified } from './templates/fixes.ts';
import {
  dataDeletion,
  incidentNotice,
  subprocessorChange,
  uninstallExport,
} from './templates/privacy.ts';
import { scannerConfirm, scannerReport } from './templates/scanner.ts';
import {
  barrierReportReceived,
  firstScanComplete,
  regressionAlert,
  weeklySummary,
  welcome,
} from './templates/store.ts';

export const TEMPLATES = {
  sign_in_link: signInLink,
  email_verification: emailVerification,
  delivery_test: deliveryTest,
  scanner_confirm: scannerConfirm,
  scanner_report: scannerReport,
  welcome,
  first_scan_complete: firstScanComplete,
  weekly_summary: weeklySummary,
  regression_alert: regressionAlert,
  barrier_report_received: barrierReportReceived,
  fix_approved: fixApproved,
  fix_verified: fixVerified,
  plan_changed: planChanged,
  usage_limit: usageLimit,
  agency_invitation: agencyInvitation,
  store_link_code: storeLinkCode,
  store_linked: storeLinked,
  data_deletion: dataDeletion,
  uninstall_export: uninstallExport,
  incident_notice: incidentNotice,
  subprocessor_change: subprocessorChange,
} as const;

export type EmailKind = keyof typeof TEMPLATES;

/** What `render(kind, input)` accepts for each kind: the JSON a job payload carries. */
export type EmailInput<K extends EmailKind> = InputOf<(typeof TEMPLATES)[K]['schema']>;

export const EMAIL_KINDS = Object.keys(TEMPLATES) as EmailKind[];

export function isEmailKind(value: string): value is EmailKind {
  return Object.hasOwn(TEMPLATES, value);
}
