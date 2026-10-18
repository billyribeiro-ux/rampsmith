// Liveness for the platform (PLAN §22): this process serves requests. It never calls the api,
// so an api outage does not restart web; the api's own /readyz covers the database.
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
