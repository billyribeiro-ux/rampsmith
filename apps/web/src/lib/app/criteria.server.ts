/**
 * WCAG 2.2 success criterion names for the finding screens. The names are the W3C's, kept once
 * in `@rampsmith/reports`' message catalog (ADR-221, `wcag_<number>` keys), so the app and the
 * exported reports always agree. `@rampsmith/reports` uses Node APIs, so it is read on the
 * server and the names travel to the browser as layout data.
 */
import { CATALOGS, WCAG22_AA } from '@rampsmith/reports';

/** Every WCAG 2.2 A and AA criterion number with its short name. */
export function criteriaNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const { id } of WCAG22_AA) {
    const message = CATALOGS.en.get(`wcag_${id.replaceAll('.', '_')}`);
    if (message?.kind === 'simple') {
      names[id] = message.pattern.map((part) => ('text' in part ? part.text : '')).join('');
    }
  }
  return names;
}
