/**
 * Finding fingerprints (PLAN §11 step 8): the rule, the selector with positional indexes and
 * generated ids stripped, and the template section the element sits in. Matching fingerprints
 * across pages merge into one finding with many occurrences.
 */
import { createHash } from 'node:crypto';

/** `div:nth-child(3) > #section-1234 > img` becomes `div > #* > img`. */
export function normalizeSelector(selector: string): string {
  return selector
    .replaceAll(/:nth-(?:child|of-type|last-child|last-of-type)\([^)]*\)/g, '')
    .replaceAll(/#[\w-]*\d[\w-]*/g, '#*')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** `shopify-section-template--1605__main` becomes `template--*__main`. */
export function templateOrigin(sectionId: string | undefined): string {
  if (sectionId === undefined) return '';
  return sectionId.replace(/^shopify-section-/, '').replaceAll(/\d+/g, '*');
}

/** SHA-256 of rule, normalized selector and template origin: the `findings.fingerprint`. */
export function fingerprint(ruleId: string, selector: string, origin: string): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(`${ruleId}\u0000${normalizeSelector(selector)}\u0000${templateOrigin(origin)}`)
      .digest(),
  );
}
