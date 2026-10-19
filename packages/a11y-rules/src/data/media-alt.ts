// Alt text of product media (PLAN §11, "Data audit"): empty or filename-like alt text.
// Product images carry product information, so empty alt text loses it (WCAG 2.2 SC 1.1.1,
// https://www.w3.org/TR/WCAG22/#non-text-content). The fix is a data fix through the Admin
// API (PLAN §4, `fileUpdate`), so the location is the whole `alt` value.
import { findingBase } from '../rules.ts';
import type { DataFinding } from '../types.ts';
import { filenamePattern } from './filename.ts';

export interface MediaAltInput {
  /** The media resource, such as `gid://shopify/MediaImage/1`. */
  readonly resource: string;
  /** The current alt text; `null` when the platform has none. */
  readonly alt: string | null;
  /** The image's file name or URL, when known, to catch alt text copied from it. */
  readonly fileName?: string | null;
}

export function auditMediaAlt(input: MediaAltInput): readonly DataFinding[] {
  const alt = input.alt ?? '';
  const location = { resource: input.resource, field: 'alt', start: 0, end: alt.length };
  if (alt.trim() === '') {
    return [{ ...findingBase('rs-media-alt-empty', 'violation'), location }];
  }
  const pattern = filenamePattern(alt, input.fileName);
  if (pattern === null) return [];
  return [{ ...findingBase('rs-media-alt-filename', 'violation'), location, data: { pattern } }];
}
