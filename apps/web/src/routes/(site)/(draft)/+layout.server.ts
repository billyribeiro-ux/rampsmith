import type { LayoutServerLoad } from './$types';

/**
 * The accessibility statement, the legal drafts and the subprocessor list are drafts the founder
 * publishes only after review, so search engines are told to leave them out (the pages carry the
 * same instruction in a meta tag for clients that ignore headers).
 */
export const load: LayoutServerLoad = ({ setHeaders }) => {
  setHeaders({ 'x-robots-tag': 'noindex, nofollow' });
};
