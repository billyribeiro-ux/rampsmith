/**
 * Loads Cloudflare Turnstile's script and renders its widget into a container (explicit
 * rendering, checked in Cloudflare's client-side documentation on 22 October 2026). The widget
 * adds a hidden `cf-turnstile-response` field to the form that contains the container.
 *
 * Cloudflare serves the script from a versioned path (`/turnstile/v0/api.js`) that it updates in
 * place and asks sites not to copy, so it cannot be pinned by hash; ADR-261 records why this is
 * the one script the site loads from elsewhere.
 */

/**
 * The `action` the free scanner's widget reports to Cloudflare (letters, digits, `_` and `-`, at
 * most 32). The api's `siteverify` check refuses a token solved for any other action (audit L3),
 * so the same value is `TURNSTILE_ACTION` in `crates/api/src/free_scan.rs`.
 */
export const TURNSTILE_ACTION = 'free_scan';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: 'auto' | 'light' | 'dark';
      size?: 'normal' | 'flexible' | 'compact';
      callback?: (token: string) => void;
      'error-callback'?: () => void;
    },
  ): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

const api = (): TurnstileApi | undefined => (globalThis as { turnstile?: TurnstileApi }).turnstile;

let loading: Promise<TurnstileApi> | undefined;

function load(origin: string): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolveApi, reject) => {
    const ready = api();
    if (ready !== undefined) {
      resolveApi(ready);
      return;
    }
    const script = document.createElement('script');
    script.src = `${origin}/turnstile/v0/api.js?render=explicit`;
    script.async = true;
    script.addEventListener('load', () => {
      const loaded = api();
      if (loaded === undefined) reject(new Error('Turnstile did not start'));
      else resolveApi(loaded);
    });
    script.addEventListener('error', () => {
      loading = undefined;
      reject(new Error('Turnstile could not be loaded'));
    });
    document.head.append(script);
  });
  return loading;
}

export interface Challenge {
  reset(): void;
  remove(): void;
}

/** Renders the widget; rejects if the script cannot be loaded (blocked, offline). */
export async function renderChallenge(
  container: HTMLElement,
  options: { origin: string; siteKey: string },
): Promise<Challenge> {
  const turnstile = await load(options.origin);
  const id = turnstile.render(container, {
    sitekey: options.siteKey,
    action: TURNSTILE_ACTION,
    theme: 'auto',
    size: 'flexible',
  });
  return {
    reset: () => {
      turnstile.reset(id);
    },
    remove: () => {
      turnstile.remove(id);
    },
  };
}
