/**
 * Browser side of the dashboard's passkey ceremonies (ADR-024). Options arrive in WebAuthn's
 * JSON form and responses leave as `PublicKeyCredential.toJSON()`; `web`'s server relays both
 * to the api and keeps the session token in an `HttpOnly` cookie.
 */

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Why a ceremony did not finish, for a message the user can act on. */
type CeremonyFailure =
  { kind: 'unsupported' } | { kind: 'cancelled' } | { kind: 'refused'; detail: string | undefined };

export type CeremonyResult = { ok: true } | ({ ok: false } & CeremonyFailure);

interface Started {
  ceremony_id: string;
  options: { publicKey: unknown };
}

/** Whether this browser can run the ceremonies as written. */
export function supportsPasskeys(): boolean {
  return (
    typeof PublicKeyCredential !== 'undefined' &&
    typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function' &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function'
  );
}

async function post(fetchImpl: Fetch, path: string, body: unknown): Promise<Response> {
  return fetchImpl(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function refused(response: Response): Promise<CeremonyResult> {
  const body: unknown = await response.json().catch(() => undefined);
  const detail =
    typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string'
      ? body.detail
      : undefined;
  return { ok: false, kind: 'refused', detail };
}

function isStarted(value: unknown): value is Started {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ceremony_id' in value &&
    typeof value.ceremony_id === 'string' &&
    'options' in value &&
    typeof value.options === 'object' &&
    value.options !== null &&
    'publicKey' in value.options
  );
}

async function ceremony(
  fetchImpl: Fetch,
  kind: 'register' | 'sign-in',
  startBody: unknown,
  run: (options: unknown) => Promise<Credential | null>,
): Promise<CeremonyResult> {
  if (!supportsPasskeys()) return { ok: false, kind: 'unsupported' };
  const start = await post(fetchImpl, `/dashboard/auth/${kind}/start`, startBody);
  if (!start.ok) return refused(start);
  const started: unknown = await start.json();
  if (!isStarted(started)) return { ok: false, kind: 'refused', detail: undefined };
  let credential: Credential | null;
  try {
    credential = await run(started.options.publicKey);
  } catch {
    // NotAllowedError: the user dismissed the prompt or it timed out.
    return { ok: false, kind: 'cancelled' };
  }
  if (!(credential instanceof PublicKeyCredential)) return { ok: false, kind: 'cancelled' };
  const finish = await post(fetchImpl, `/dashboard/auth/${kind}/finish`, {
    ceremony_id: started.ceremony_id,
    credential: credential.toJSON(),
  });
  return finish.ok ? { ok: true } : refused(finish);
}

/** Creates an account whose only credential is a new passkey. */
export function register(
  fetchImpl: Fetch,
  email: string,
  displayName: string,
): Promise<CeremonyResult> {
  return ceremony(fetchImpl, 'register', { email, display_name: displayName }, (options) =>
    navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
        options as PublicKeyCredentialCreationOptionsJSON,
      ),
    }),
  );
}

/** Signs in with any passkey the browser holds for this site. */
export function signIn(fetchImpl: Fetch): Promise<CeremonyResult> {
  return ceremony(fetchImpl, 'sign-in', {}, (options) =>
    navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
        options as PublicKeyCredentialRequestOptionsJSON,
      ),
    }),
  );
}
