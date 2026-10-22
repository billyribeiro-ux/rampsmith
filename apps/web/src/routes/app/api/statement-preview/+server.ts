import { API_URL } from '$app/env/private';
import { renderStatement, ReportInputError } from '@rampsmith/reports';
import { openFindings } from '#lib/app/export.server.ts';
import { statementInput } from '#lib/app/reports.server.ts';
import type { Overview, StatementContent } from '#lib/app/types.ts';
import {
  bearer,
  failureFrom,
  jsonBody,
  problem,
  unauthenticated,
  upstream as connect,
} from '#lib/app/upstream.server.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 64 * 1024;

/** Renders the statement the merchant is editing, without saving it (ADR-091). */
export const POST: RequestHandler = async ({ request }) => {
  const authorization = bearer(request);
  if (authorization === undefined) return unauthenticated();
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return problem(413, 'payload_too_large', 'Request too large');
  let content: StatementContent;
  try {
    content = JSON.parse(text) as StatementContent;
  } catch {
    return problem(400, 'bad_request', 'Invalid body');
  }

  const upstream = connect(API_URL, authorization);
  let overview: Overview | undefined;
  let findings;
  try {
    const response = await upstream.call('overview');
    if (!response.ok) return failureFrom(response);
    overview = await jsonBody<Overview>(response);
    findings = await openFindings(upstream);
  } catch {
    return problem(503, 'unavailable', 'Service unavailable');
  }
  if (overview === undefined || findings === undefined) {
    return problem(502, 'bad_gateway', 'Bad gateway');
  }

  try {
    const rendered = renderStatement(
      statementInput({ overview, findings, content, locale: 'en', now: new Date() }),
    );
    return Response.json(
      {
        status: rendered.status,
        document: rendered.document.html,
        fragment: rendered.fragment,
        text: rendered.text,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    // Which entry the renderer refused, never its value.
    if (error instanceof ReportInputError) {
      return problem(422, 'validation_failed', 'The statement entries are incomplete', {
        errors: [{ field: error.field, message: 'invalid' }],
      });
    }
    return problem(422, 'unprocessable', 'The statement could not be produced');
  }
};
