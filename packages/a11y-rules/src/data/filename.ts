// Detects alt text that is a file name rather than a description (WCAG 2.2 SC 1.1.1: the text
// alternative must serve the equivalent purpose, https://www.w3.org/TR/WCAG22/#non-text-content).

/** Which pattern made the text look like a file name; reported in the finding's data. */
export type FilenamePattern =
  'extension' | 'camera' | 'underscore' | 'dimensions' | 'hash' | 'matches-file-name';

// Every check below is linear in the input, and longer texts are never file names, so hostile
// alt text cannot make the audit backtrack (security audit H3). Only anchored regular
// expressions with unambiguous repetition are used; the rest are hand-written scans.

/** Longest alt text still considered as a possible file name. */
const MAX_FILENAME_LENGTH = 256;

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'heic',
  'heif',
  'tif',
  'tiff',
  'bmp',
]);
// Names cameras, phones and screenshot tools give files, followed by digits.
const CAMERA =
  /^(?:img|image|dsc|dscn|dscf|dcim|pxl|mvimg|photo|pic|picture|screenshot|screen[\s_-]?shot|capture|untitled|scan)[\s_-]*\d/i;
const HASH = /^[0-9a-f-]+$/i;

/** Whether the text, without any query string or fragment, ends in an image extension. */
function hasImageExtension(text: string): boolean {
  const cut = text.search(/[?#]/);
  const base = cut === -1 ? text : text.slice(0, cut);
  const dot = base.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** Whether the text holds `<2+ digits> x <2+ digits>`, spaces allowed around the `x`. */
function hasDimensions(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== 'x' && ch !== 'X' && ch !== '×') continue;
    let left = i - 1;
    while (left >= 0 && text.charAt(left) === ' ') left -= 1;
    let digitsLeft = 0;
    while (left >= 0 && isDigit(text.charCodeAt(left)) && digitsLeft < 2) {
      digitsLeft += 1;
      left -= 1;
    }
    let right = i + 1;
    while (right < text.length && text.charAt(right) === ' ') right += 1;
    let digitsRight = 0;
    while (right < text.length && isDigit(text.charCodeAt(right)) && digitsRight < 2) {
      digitsRight += 1;
      right += 1;
    }
    if (digitsLeft === 2 && digitsRight === 2) return true;
  }
  return false;
}

/** A hexadecimal run of 8+ with optional hyphenated groups of 4+, or 20+ hex and hyphens. */
function looksLikeHash(text: string): boolean {
  if (!HASH.test(text) || !/\d/.test(text)) return false;
  if (text.length >= 20) return true;
  const groups = text.split('-');
  const [first, ...rest] = groups;
  return (first?.length ?? 0) >= 8 && rest.every((g) => g.length >= 4);
}

/** Lower-cases and joins words with single hyphens, for comparing a text with a file stem. */
function stem(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_.-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The file name without directories, query string or extension, from a path or URL. */
export function fileStem(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.split(/[?#]/, 1)[0] ?? '';
  const base = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The pattern that makes `alt` look like a file name, or `null` when it reads as text.
 * `fileName` is the image's own file name or URL, when known.
 */
export function filenamePattern(alt: string, fileName?: string | null): FilenamePattern | null {
  if (alt.length > MAX_FILENAME_LENGTH * 4) return null;
  const text = alt.trim();
  if (text === '' || text.length > MAX_FILENAME_LENGTH) return null;
  if (hasImageExtension(text)) return 'extension';
  if (CAMERA.test(text)) return 'camera';
  const oneWord = !/\s/.test(text);
  if (oneWord && looksLikeHash(text)) return 'hash';
  if (oneWord && hasDimensions(text)) return 'dimensions';
  if (oneWord && text.includes('_') && /[a-z0-9]_[a-z0-9]/i.test(text)) return 'underscore';
  if (fileName !== undefined && fileName !== null && oneWord && fileName.length <= 4_096) {
    const fromFile = stem(fileStem(fileName));
    if (fromFile !== '' && stem(text) === fromFile) return 'matches-file-name';
  }
  return null;
}
