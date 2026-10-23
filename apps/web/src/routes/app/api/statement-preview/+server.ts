import { API_URL } from '$app/env/private';
import { renderStatement, ReportInputError } from '@rampsmith/reports';
import { openFindingsFor } from '#lib/app/export.server.ts';
import { statementInput } from '#lib/app/reports.server.ts';
import type { Overview, StatementContent } from '#lib/app/types.ts';
import {
  bearer,
  failureFrom,
  jsonBody,
  problem,
  tooLarge,
  unauthenticated,
  upstream as connect,
} from '#lib/app/upstream.server.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 64 * 1024;

/** Renders the statement the merchant is editing, without saving it (ADR-091). */
export const POST: RequestHandler = async ({ request }) => {
  const authorization = bearer(request);
  if (authorization === undefined) return unauthenticated();
  // Bytes, not UTF-16 units: a body of multi-byte characters is longer than its `length`.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return problem(413, 'payload_too_large', 'Request too large');
  const text = await request.text();
  if (tooLarge(text, MAX_BODY_BYTES)) {
    return problem(413, 'payload_too_large', 'Request too large');
  }
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
    if (overview === undefined) return problem(502, 'bad_gateway', 'Bad gateway');
    findings = await openFindingsFor(upstream, overview);
  } catch {
    return problem(503, 'unavailable', 'Service unavailable');
  }
  if (findings === undefined) {
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
