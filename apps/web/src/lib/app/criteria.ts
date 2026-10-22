/** Helpers over the criterion names the app layout loads on the server (`criteria.server.ts`). */

export type CriteriaNames = Readonly<Record<string, string>>;

/** The W3C "Understanding" page for a criterion (https://www.w3.org/WAI/WCAG22/Understanding/). */
export function understandingUrl(names: CriteriaNames, id: string): string | undefined {
  const name = names[id];
  if (name === undefined) return undefined;
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html`;
}
