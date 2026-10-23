/**
 * What the engine needs to send email, read from the environment once at startup (ADR-273).
 * Nothing here throws for a missing or bad setting: the engine's scans do not depend on email,
 * so a bad value becomes a `problems` entry (fixed text, never the value) and `email.send` jobs
 * fail retryably with the reason until it is fixed.
 */
import {
  createEmailRenderer,
  createSesSender,
  sesConfigFromEnv,
  SesConfigError,
  SettingsError,
  type EmailRenderer,
  type EmailSender,
  type SesConfig,
} from '@rampsmith/email';

export interface EmailRuntime {
  /** Undefined until the app origin and the support address are set and valid. */
  readonly renderer: EmailRenderer | undefined;
  /** The SES transport. Undefined until LAUNCH.md C row 7 is complete and valid. */
  readonly transport: EmailSender | undefined;
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
  const appOrigin = present(env, 'APP_ORIGIN');
  if (appOrigin === undefined) {
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
          appOrigin,
          siteOrigin: present(env, 'SITE_ORIGIN') ?? appOrigin,
          supportAddress: support,
          postalAddress: present(env, 'EMAIL_POSTAL_ADDRESS'),
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
  return { renderer, transport, problems };
}
