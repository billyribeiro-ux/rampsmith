/**
 * What the engine needs to send email, read from the environment once at startup (ADR-273).
 * Nothing here throws for a missing or bad setting: the engine's scans do not depend on email,
 * so a bad value becomes a `problems` entry (fixed text, never the value) and `email.send` jobs
 * fail retryably with the reason until it is fixed.
 */
import {
  createEmailRenderer,
  LinkKeyError,
  LinkKeyRing,
  parseOrigin,
  createSesSender,
  sesConfigFromEnv,
  SesConfigError,
  SettingsError,
  type EmailRenderer,
  type EmailSender,
  type SesConfig,
} from '@rampsmith/email';
import { DEFAULT_APP_HANDLE, isAppHandle } from './app-links.ts';
import type { EmailLinkSettings } from './links.ts';

export interface EmailRuntime {
  /** Undefined until the app origin and the support address are set and valid. */
  readonly renderer: EmailRenderer | undefined;
  /** The SES transport. Undefined until LAUNCH.md C row 7 is complete and valid. */
  readonly transport: EmailSender | undefined;
  /**
   * The signed links of subscribed mail (ADR-274). Undefined until `EMAIL_LINK_KEYS` and the
   * one-click origin are set; notification and marketing mail waits for them, the rest does not.
   */
  readonly links: EmailLinkSettings | undefined;
  /** The Shopify app's handle, which the links into the admin are built from (ADR-279). */
  readonly appHandle: string;
  /** Why something is undefined, in fixed words that name settings and never hold a value. */
  readonly problems: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function present(env: Env, name: string): string | undefined {
  const value = (env[name] ?? '').trim();
  return value === '' ? undefined : value;
}

/** The address inside `Name <address>`, or the text itself. */
function addressOf(from: string): string {
  const match = /<([^<>]+)>/u.exec(from);
  return (match?.[1] ?? from).trim();
}

/**
 * Builds the renderer and the SES transport. `ses` overrides parts of the SES settings for tests
 * (the endpoint of a local stand-in, a fake clock).
 */
export function createEmailRuntime(
  env: Env,
  ses: Partial<Pick<SesConfig, 'endpoint' | 'fetch' | 'now' | 'timeoutMs'>> = {},
): EmailRuntime {
  const now = ses.now ?? ((): Date => new Date());
  const problems: string[] = [];

  const sesSettings = sesConfigFromEnv(env);
  let transport: EmailSender | undefined;
  if ('missing' in sesSettings) {
    problems.push(
      `Amazon SES is not configured (LAUNCH.md C row 7): ${sesSettings.missing.join(', ')} must be set`,
    );
  } else {
    try {
      transport = createSesSender({ ...sesSettings, ...ses });
    } catch (error) {
      problems.push(
        error instanceof SesConfigError
          ? error.message
          : 'Amazon SES settings (LAUNCH.md C row 7) were refused',
      );
    }
  }

  let renderer: EmailRenderer | undefined;
  const appOriginText = present(env, 'APP_ORIGIN');
  if (appOriginText === undefined) {
    problems.push('APP_ORIGIN must be set (the app origin that links in emails point at)');
  } else {
    // The support address defaults to the sender's: it is verified, and replies reach it.
    const from = present(env, 'EMAIL_FROM');
    const support =
      present(env, 'EMAIL_SUPPORT_ADDRESS') ?? (from === undefined ? undefined : addressOf(from));
    if (support === undefined) {
      problems.push(
        'EMAIL_SUPPORT_ADDRESS or EMAIL_FROM must be set (the support address in footers)',
      );
    } else {
      try {
        renderer = createEmailRenderer({
          appOrigin: appOriginText,
          siteOrigin: present(env, 'SITE_ORIGIN') ?? appOriginText,
          supportAddress: support,
          postalAddress: present(env, 'EMAIL_POSTAL_ADDRESS'),
          oneClickOrigin: present(env, 'EMAIL_ONE_CLICK_ORIGIN'),
        });
      } catch (error) {
        problems.push(
          error instanceof SettingsError
            ? error.message
            : 'the email settings (APP_ORIGIN, SITE_ORIGIN, EMAIL_SUPPORT_ADDRESS) were refused',
        );
      }
    }
  }

  let links: EmailLinkSettings | undefined;
  const keys = present(env, 'EMAIL_LINK_KEYS');
  const oneClickOrigin = parseOrigin(present(env, 'EMAIL_ONE_CLICK_ORIGIN') ?? '');
  const linkAppOrigin = parseOrigin(appOriginText ?? '');
  if (keys === undefined) {
    problems.push(
      'EMAIL_LINK_KEYS must be set (LAUNCH.md C row 12): notification emails need signed unsubscribe links',
    );
  } else if (oneClickOrigin === null) {
    problems.push(
      'EMAIL_ONE_CLICK_ORIGIN must be set to the public webhook host origin (RFC 8058 one-click unsubscribe)',
    );
  } else if (linkAppOrigin !== null) {
    try {
      links = { ring: LinkKeyRing.parse(keys), appOrigin: linkAppOrigin, oneClickOrigin, now };
    } catch (error) {
      problems.push(
        error instanceof LinkKeyError
          ? error.message
          : 'EMAIL_LINK_KEYS (LAUNCH.md C row 12) was refused',
      );
    }
  }
  let appHandle = DEFAULT_APP_HANDLE;
  const handleText = present(env, 'SHOPIFY_APP_HANDLE');
  if (handleText !== undefined) {
    if (isAppHandle(handleText)) {
      appHandle = handleText;
    } else {
      problems.push(
        'SHOPIFY_APP_HANDLE is not a Shopify app handle (lowercase letters, digits, -)',
      );
    }
  }
  return { renderer, transport, links, appHandle, problems };
}
