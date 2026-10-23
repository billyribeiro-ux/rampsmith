import { outcomeOf } from '#lib/server/github-connect.ts';
import type { PageServerLoad } from './$types';

/** The word the callback left in the address; nothing else about the connection is shown here. */
export const load: PageServerLoad = ({ url }) => ({
  result: outcomeOf(url.searchParams.get('result')),
});
