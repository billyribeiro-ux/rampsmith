/**
 * Scrubbing before storage (PLAN §18): HTML excerpts lose form values, email addresses and
 * phone-number patterns, and are cut to 512 characters.
 */
const MAX = 512;

export function scrubExcerpt(html: string): string {
  return html
    .replaceAll(/\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' value=""')
    .replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replaceAll(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .slice(0, MAX);
}
