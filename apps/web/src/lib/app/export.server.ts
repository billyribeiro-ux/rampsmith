/**
 * Loads what the remediation log and the statement preview need from the api, following
 * cursors up to a fixed ceiling so one request cannot page without end.
 */
import { jsonBody, type Upstream } from './upstream.server.ts';
import type { FindingSummary, FixSummary, Overview } from './types.ts';

/** Pages followed per list, so one request cannot page without end. */
const PAGE_LIMIT = 40;
/** Items asked for per page: the api's maximum, so a store needs a quarter of the requests. */
const PAGE_SIZE = '100';

async function pages<U>(
  upstream: Upstream,
  path: string,
  query: Record<string, string>,
): Promise<U[] | undefined> {
  const out: U[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const params = new URLSearchParams({ ...query, limit: PAGE_SIZE });
    if (cursor !== null) params.set('cursor', cursor);
    const response = await upstream.call(`${path}?${params.toString()}`);
    if (!response.ok) {
      // Close the body: an unread response holds its connection (security audit L4).
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const body = await jsonBody<{ items: readonly U[]; next_cursor: string | null }>(response);
    if (body === undefined) return undefined;
    out.push(...body.items);
    cursor = body.next_cursor;
    if (cursor === null) return out;
  }
  return out;
}

export const allFixes = (upstream: Upstream): Promise<FixSummary[] | undefined> =>
  pages<FixSummary>(upstream, 'fixes', { state: 'all' });

const openFindings = (upstream: Upstream): Promise<FindingSummary[] | undefined> =>
  pages<FindingSummary>(upstream, 'findings', { status: 'open' });

/** How long a loaded list of open findings is reused. */
const FINDINGS_TTL_MS = 5 * 60 * 1000;
const FINDINGS_MAX_ENTRIES = 200;
const findingsCache = new Map<
  string,
  { readonly findings: FindingSummary[]; readonly at: number }
>();

/**
 * What the list of open findings depends on, as the api's overview reports it: the shop, the
 * latest scan and the counts a fix changes. When none of it moved, the list did not either.
 */
export function findingsKey(overview: Overview): string {
  const scan = overview.latest_scan;
  return JSON.stringify([
    overview.shop.domain,
    scan?.id ?? null,
    scan?.finished_at ?? null,
    overview.open_by_impact,
    overview.fixes_applied,
    overview.fixes_awaiting_approval,
  ]);
}

/**
 * The open findings for the statement preview, loaded once per state of the shop instead of on
 * every keystroke's preview (security audit L6, ADR-099). `overview` came from the api with the
 * visitor's token, so its shop domain is the verified one and cannot name another shop's list.
 */
export async function openFindingsFor(
  upstream: Upstream,
  overview: Overview,
  now: number = Date.now(),
): Promise<FindingSummary[] | undefined> {
  const key = findingsKey(overview);
  const hit = findingsCache.get(key);
  if (hit !== undefined && now - hit.at < FINDINGS_TTL_MS) return hit.findings;
  const findings = await openFindings(upstream);
  if (findings === undefined) return undefined;
  if (findingsCache.size >= FINDINGS_MAX_ENTRIES) {
    for (const [k, v] of findingsCache) if (now - v.at >= FINDINGS_TTL_MS) findingsCache.delete(k);
    if (findingsCache.size >= FINDINGS_MAX_ENTRIES) findingsCache.clear();
  }
  findingsCache.set(key, { findings, at: now });
  return findings;
}
