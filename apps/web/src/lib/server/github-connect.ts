/**
 * The two browser hops of connecting GitHub (ADR-291). The staff member's click in App Home ends
 * at `/github/connect` with a one-time state; GitHub's installation page sends the browser back
 * to `/github/callback`. Neither request carries a Shopify session, so the state is what ties the
 * browser to a store: it travels in an `HttpOnly` cookie, and the api only accepts it once, for
 * the store it was issued to. This module holds no secret and logs nothing it is given.
 */
import type { ApiClient } from '@rampsmith/contracts-ts';

export const STATE_COOKIE = 'rampsmith_github_state';
/** Ten minutes, the api's lifetime for a state. */
export const STATE_MAX_AGE_SECONDS = 600;

const STATE = /^[A-Za-z0-9_-]{43}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u;
const DIGITS = /^[1-9][0-9]{0,18}$/u;

export function stateOf(value: unknown): string | undefined {
  return typeof value === 'string' && STATE.test(value) ? value : undefined;
}

/** GitHub's installation page for the App, or `undefined` while no App slug is configured. */
export function installationUrl(slug: string, state: string): string | undefined {
  if (!SLUG.test(slug) || !STATE.test(state)) return undefined;
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}

/** What the result page tells the person. */
export type Outcome = 'connected' | 'expired' | 'refused' | 'unavailable';

export function outcomeOf(value: unknown): Outcome {
  return value === 'connected' || value === 'expired' || value === 'refused'
    ? value
    : 'unavailable';
}

export interface CallbackInput {
  /** The state from the browser's cookie. */
  readonly state: string | undefined;
  /** The `state` GitHub added to the redirect, when it did. */
  readonly echoed: string | null;
  readonly code: string | null;
  readonly installationId: string | null;
}

/** Hands what GitHub's redirect carried to the api and says how it went. */
export async function finishConnection(client: ApiClient, input: CallbackInput): Promise<Outcome> {
  const { state, code, installationId } = input;
  if (state === undefined) return 'expired';
  if (code === null || code === '' || code.length > 512) return 'refused';
  if (installationId === null || !DIGITS.test(installationId)) return 'refused';
  const echoed = input.echoed === null || input.echoed === '' ? null : input.echoed;
  const done = await client
    .POST('/v1/github/callback', {
      body: {
        state,
        echoed_state: echoed,
        code,
        installation_id: Number(installationId),
      },
    })
    .catch(() => undefined);
  const status = done?.response.status;
  if (status === 200) return 'connected';
  if (status === 400) return 'expired';
  if (status === 403 || status === 409) return 'refused';
  return 'unavailable';
}
