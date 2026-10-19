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
export { EMAIL_KINDS, isEmailKind, type EmailInput, type EmailKind } from './kinds.ts';
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
export {
  checkOutbound,
  describeForLog,
  guardSender,
  MemorySender,
  SendRefusedError,
  type EmailSender,
  type OutboundEmail,
  type RefusalReason,
  type SendReceipt,
} from './sender.ts';
export { SettingsError, type EmailSettings } from './settings.ts';
export { CATEGORIES, type Category } from './template.ts';
export { BASE_LOCALE, SHIPPED_CATALOGS } from './translator.ts';
export { CatalogError } from './i18n.ts';
