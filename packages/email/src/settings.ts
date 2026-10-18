import { isEmailAddress, parseOrigin, SHOPIFY_ADMIN_ORIGIN, type Origins } from './links.ts';
import { multiLine } from './sanitize.ts';

/** Deployment settings, the same for every email a process renders. */
export interface EmailSettings {
  /** The dashboard and API origin, such as `https://app.rampsmith.com`. */
  readonly appOrigin: string;
  /** The marketing site and free scanner origin, such as `https://rampsmith.com`. */
  readonly siteOrigin: string;
  /** The support inbox shown in every footer, such as `support@rampsmith.com`. */
  readonly supportAddress: string;
  /**
   * Rampsmith's physical postal address, required in commercial email by CAN-SPAM and CASL
   * (ADR-191). A founder input: until it is set, emails that must carry it render a visible
   * placeholder and report `postal-address-missing`, and `guardSender` refuses to send them.
   */
  readonly postalAddress?: string | undefined;
}

/** The validated form of {@link EmailSettings}. */
export interface ResolvedSettings {
  readonly origins: Origins;
  readonly supportAddress: string;
  readonly postalAddress: string | null;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(`email settings: ${message}`);
    this.name = 'SettingsError';
  }
}

/** Longest postal address accepted, in characters. */
const MAX_POSTAL_ADDRESS = 300;

export function resolveSettings(settings: EmailSettings): ResolvedSettings {
  const app = parseOrigin(settings.appOrigin);
  if (app === null) {
    throw new SettingsError('appOrigin must be an HTTPS origin (HTTP only on a loopback host)');
  }
  const site = parseOrigin(settings.siteOrigin);
  if (site === null) {
    throw new SettingsError('siteOrigin must be an HTTPS origin (HTTP only on a loopback host)');
  }
  if (!isEmailAddress(settings.supportAddress)) {
    throw new SettingsError('supportAddress must be a plain email address');
  }
  let postalAddress: string | null = null;
  if (settings.postalAddress !== undefined) {
    postalAddress = multiLine(settings.postalAddress);
    if (postalAddress.length === 0 || postalAddress.length > MAX_POSTAL_ADDRESS) {
      throw new SettingsError(
        `postalAddress must hold 1 to ${String(MAX_POSTAL_ADDRESS)} characters when set`,
      );
    }
  }
  return {
    origins: { app, site, shopifyAdmin: SHOPIFY_ADMIN_ORIGIN },
    supportAddress: settings.supportAddress,
    postalAddress,
  };
}
