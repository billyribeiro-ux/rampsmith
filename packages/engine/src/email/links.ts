/**
 * The links in a subscribed email (ADR-274): the unsubscribe link of the message's category, the
 * preferences link and the RFC 8058 one-click address. The engine mints them when it sends, so
 * the key ring (`EMAIL_LINK_KEYS`) lives here and in the api that reads them, and the job that
 * queues the email never sees a token.
 */
import {
  LINK_TTL_SECONDS,
  LinkKeyRing,
  mintLinkToken,
  type OptOutCategory,
} from '@rampsmith/email';

export interface EmailLinkSettings {
  readonly ring: LinkKeyRing;
  /** The app origin: the pages `/email/unsubscribe` and `/email/preferences`. */
  readonly appOrigin: string;
  /** The public webhook listener, which takes the one-click POST. */
  readonly oneClickOrigin: string;
  readonly now: () => Date;
}

export interface SubscriptionLinks {
  readonly unsubscribeUrl: string;
  readonly preferencesUrl: string;
  readonly oneClickUrl: string;
}

export interface LinkSubject {
  readonly tenantId: string;
  readonly shopId: string;
  readonly addressHash: Uint8Array;
  readonly category: OptOutCategory;
}

/** The three links for one message. */
export function subscriptionLinks(
  settings: EmailLinkSettings,
  subject: LinkSubject,
): SubscriptionLinks {
  const expiresAt = Math.floor(settings.now().getTime() / 1000) + LINK_TTL_SECONDS;
  const base = {
    expiresAt,
    tenantId: subject.tenantId,
    shopId: subject.shopId,
    addressHash: subject.addressHash,
  };
  const unsubscribe = mintLinkToken(settings.ring, {
    ...base,
    purpose: 'unsubscribe',
    category: subject.category,
  });
  const preferences = mintLinkToken(settings.ring, { ...base, purpose: 'preferences' });
  return {
    unsubscribeUrl: `${settings.appOrigin}/email/unsubscribe?t=${unsubscribe}`,
    preferencesUrl: `${settings.appOrigin}/email/preferences?t=${preferences}`,
    oneClickUrl: `${settings.oneClickOrigin}/webhooks/email/unsubscribe?t=${unsubscribe}`,
  };
}
