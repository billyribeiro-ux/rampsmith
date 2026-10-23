/**
 * The pages behind the links in Rampsmith's emails (ADR-274): read what a link allows, and
 * switch a category on or off. The token is the only thing that says whose mail it is, so it
 * is checked by the api; this module never decodes it, never logs it, and never sends it to
 * anyone else.
 */
import type { ApiClient } from '@rampsmith/contracts-ts';

export type EmailCategory = 'notification' | 'marketing';

interface CategoryState {
  readonly category: EmailCategory;
  readonly enabled: boolean;
}

/** What the page shows. `unavailable` means the api could not be asked, not that the link is bad. */
export type LinkView =
  | {
      readonly status: 'ok';
      readonly purpose: 'unsubscribe' | 'preferences';
      readonly categories: readonly CategoryState[];
    }
  | { readonly status: 'expired' | 'invalid' | 'unavailable' };

const TOKEN = /^[A-Za-z0-9_-]{1,400}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function viewOf(value: unknown): LinkView {
  if (!isRecord(value)) return { status: 'unavailable' };
  if (value['status'] === 'expired') return { status: 'expired' };
  if (value['status'] !== 'ok') return { status: 'invalid' };
  const purpose = value['purpose'];
  const raw = value['categories'];
  if ((purpose !== 'unsubscribe' && purpose !== 'preferences') || !Array.isArray(raw)) {
    return { status: 'unavailable' };
  }
  const categories: CategoryState[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || typeof entry['enabled'] !== 'boolean') {
      return { status: 'unavailable' };
    }
    const category = entry['category'];
    if (category !== 'notification' && category !== 'marketing') return { status: 'unavailable' };
    categories.push({ category, enabled: entry['enabled'] });
  }
  return { status: 'ok', purpose, categories };
}

/** The token as the page received it, or `undefined` if it cannot be one of ours. */
export function wellFormed(token: unknown): string | undefined {
  return typeof token === 'string' && TOKEN.test(token) ? token : undefined;
}

export async function inspectLink(client: ApiClient, token: unknown): Promise<LinkView> {
  const t = wellFormed(token);
  if (t === undefined) return { status: 'invalid' };
  const got = await client
    .POST('/v1/email/links/inspect', { body: { token: t } })
    .catch(() => undefined);
  return got?.response.status === 200 ? viewOf(got.data) : { status: 'unavailable' };
}

export function categoryOf(value: unknown): EmailCategory | undefined {
  return value === 'notification' || value === 'marketing' ? value : undefined;
}

export async function changeLink(
  client: ApiClient,
  token: unknown,
  category: EmailCategory,
  enabled: boolean,
): Promise<LinkView> {
  const t = wellFormed(token);
  if (t === undefined) return { status: 'invalid' };
  const got = await client
    .POST('/v1/email/links/preference', { body: { token: t, category, enabled } })
    .catch(() => undefined);
  return got?.response.status === 200 ? viewOf(got.data) : { status: 'unavailable' };
}
