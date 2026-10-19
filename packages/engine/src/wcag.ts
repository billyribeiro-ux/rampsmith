/** WCAG success criteria named by axe-core tags such as `wcag1410` (1.4.10). */
const CRITERION = /^wcag(\d)(\d)(\d+)$/;

/** The success criteria in `tags`, sorted and without duplicates. */
export function criteriaFromTags(tags: readonly string[]): string[] {
  const criteria = new Set<string>();
  for (const tag of tags) {
    const match = CRITERION.exec(tag);
    if (match !== null) criteria.add(`${match[1] ?? ''}.${match[2] ?? ''}.${match[3] ?? ''}`);
  }
  return [...criteria].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
