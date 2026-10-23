/**
 * @rampsmith/email: every onboarding and transactional email Rampsmith sends, rendered as
 * plain text and accessible HTML from typed inputs (LAUNCH.md B; ADR-191 to ADR-194).
 *
 * ```ts
 * const emails = createEmailRenderer({ appOrigin, siteOrigin, supportAddress, postalAddress });
 * const email = emails.render('sign_in_link', { signInUrl, expiresInMinutes: 15 });
 * await guardSender(sesSender).send({ to, idempotencyKey, email });
 * ```
 */
export { isEmailAddress, parseOrigin } from './links.ts';
export { categoryOf, EMAIL_KINDS, isEmailKind, type EmailInput, type EmailKind } from './kinds.ts';
export {
  createEmailRenderer,
  POSTAL_ADDRESS_PLACEHOLDER,
  RenderedEmail,
  type CatalogSources,
  type EmailRenderer,
  type RendererOptions,
  type SendProblem,
} from './render.ts';
export { InputError } from './schema.ts';
export { MemoryLedger, withLedger, type IdempotencyLedger, type LedgerClaim } from './ledger.ts';
export { signRequest, type AwsCredentials, type SigningRequest } from './sigv4.ts';
export {
  createSesSender,
  encodeSubject,
  failureFor,
  sesConfigFromEnv,
  SesConfigError,
  type SesConfig,
} from './ses.ts';
export {
  checkOutbound,
  describeForLog,
  guardSender,
  MAX_ATTACHMENT_BYTES,
  MemorySender,
  SendFailure,
  SendRefusedError,
  type EmailAttachment,
  type EmailSender,
  type OutboundEmail,
  type RefusalReason,
  type SendReceipt,
} from './sender.ts';
export { SettingsError, type EmailSettings } from './settings.ts';
export {
  LINK_TTL_SECONDS,
  LinkKeyError,
  LinkKeyRing,
  mintLinkToken,
  OPT_OUT_CATEGORIES,
  verifyLinkToken,
  type LinkClaims,
  type LinkPurpose,
  type LinkRefusal,
  type LinkVerdict,
  type OptOutCategory,
} from './link-token.ts';
export { CATEGORIES, isSubscribed as isSubscribedCategory, type Category } from './template.ts';
export { BASE_LOCALE, SHIPPED_CATALOGS } from './translator.ts';
export { CatalogError } from './i18n.ts';
