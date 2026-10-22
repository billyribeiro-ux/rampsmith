import { API_URL } from '$app/env/private';
import { remediationLogCsv, remediationLogJson } from '@rampsmith/reports';
import { allFixes } from '#lib/app/export.server.ts';
import { remediationEntries } from '#lib/app/reports.server.ts';
import type { Overview } from '#lib/app/types.ts';
import {
  bearer,
  failureFrom,
  jsonBody,
  problem,
  unauthenticated,
  upstream as connect,
} from '#lib/app/upstream.server.ts';
import type { RequestHandler } from './$types';

/** The remediation log as a CSV or JSON download, made by `packages/reports` (ADR-091). */
export const GET: RequestHandler = async ({ request, url }) => {
  const authorization = bearer(request);
  if (authorization === undefined) return unauthenticated();
  const format = url.searchParams.get('format');
  if (format !== 'csv' && format !== 'json') return problem(400, 'bad_request', 'Unknown format');

  const upstream = connect(API_URL, authorization);
  let overview: Overview | undefined;
  let fixes;
  try {
    const response = await upstream.call('overview');
    if (!response.ok) return failureFrom(response);
    overview = await jsonBody<Overview>(response);
    fixes = await allFixes(upstream);
  } catch {
    return problem(503, 'unavailable', 'Service unavailable');
  }
  if (overview === undefined || fixes === undefined)
    return problem(502, 'bad_gateway', 'Bad gateway');

  const input = {
    locale: 'en',
    site: {
      name: overview.shop.name ?? overview.shop.domain,
      url: `https://${overview.shop.domain}`,
      platform: 'shopify' as const,
    },
    generatedAt: new Date(),
    entries: remediationEntries(fixes),
  };
  try {
    const body = format === 'csv' ? remediationLogCsv(input) : remediationLogJson(input);
    return new Response(body, {
      headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
        'content-disposition': `attachment; filename="rampsmith-remediation-log.${format}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return problem(422, 'unprocessable', 'The log could not be produced');
  }
};
