export {
  classifyCoverage,
  coverageFromRules,
  criteriaFromAxeTags,
  type Coverage,
  type CoverageInput,
} from './coverage.ts';
export { ReportInputError } from './validate.ts';
export {
  MAX_LISTED_BARRIERS,
  renderStatement,
  statementStatus,
  type MerchantLimitation,
  type RenderedStatement,
  type StatementContact,
  type StatementFinding,
  type StatementInput,
  type StatementStatus,
} from './statement.ts';
export {
  MAX_CELL,
  remediationLogCsv,
  remediationLogJson,
  verificationResult,
  type Approver,
  type FixChange,
  type RemediationEntry,
  type RemediationFinding,
  type RemediationLogInput,
  type VerificationResult,
} from './remediation-log.ts';
export {
  MAX_CHART_SCANS,
  renderSummary,
  type RenderedSummary,
  type SummaryInput,
  type SummaryScan,
} from './summary.ts';
export { passRate } from './charts.ts';
export { ReportDocument, CONTENT_SECURITY_POLICY } from './document.ts';
export { CATALOGS, LOCALES, resolveLocale, type Locale } from './i18n.ts';
export { WCAG22_AA, type SuccessCriterion, type WcagLevel } from './wcag.ts';
export {
  renderPdf,
  ReportRenderError,
  type PdfBrowser,
  type PdfContext,
  type PdfOptions,
  type PdfPage,
} from './pdf.ts';
