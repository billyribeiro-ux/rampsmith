/**
 * Loads what the remediation log and the statement preview need from the api, following
 * cursors up to a fixed ceiling so one request cannot page without end.
 */
import { jsonBody, type Upstream } from './upstream.server.ts';
import type { FindingSummary, FixSummary } from './types.ts';

const PAGE_LIMIT = 40;

async function pages<U>(
  upstream: Upstream,
  path: string,
  query: Record<string, string>,
): Promise<U[] | undefined> {
  const out: U[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const params = new URLSearchParams(query);
    if (cursor !== null) params.set('cursor', cursor);
    const response = await upstream.call(`${path}?${params.toString()}`);
    if (!response.ok) return undefined;
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

export const openFindings = (upstream: Upstream): Promise<FindingSummary[] | undefined> =>
  pages<FindingSummary>(upstream, 'findings', { status: 'open' });
