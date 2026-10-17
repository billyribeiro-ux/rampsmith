// Detects alt text that is a file name rather than a description (WCAG 2.2 SC 1.1.1: the text
// alternative must serve the equivalent purpose, https://www.w3.org/TR/WCAG22/#non-text-content).

/** Which pattern made the text look like a file name; reported in the finding's data. */
export type FilenamePattern =
  'extension' | 'camera' | 'underscore' | 'dimensions' | 'hash' | 'matches-file-name';

const IMAGE_EXTENSION = /\.(?:jpe?g|jfif|png|gif|webp|avif|svg|heic|heif|tiff?|bmp)(?:[?#].*)?$/i;
// Names cameras, phones and screenshot tools give files, followed by digits.
const CAMERA =
  /^(?:img|image|dsc|dscn|dscf|dcim|pxl|mvimg|photo|pic|picture|screenshot|screen[\s_-]?shot|capture|untitled|scan)[\s_-]*\d+/i;
const DIMENSIONS = /\d{2,}\s*[x×]\s*\d{2,}/i;
const HASH = /^(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,})*|[0-9a-f-]{20,})$/i;

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
  const text = alt.trim();
  if (text === '') return null;
  if (IMAGE_EXTENSION.test(text)) return 'extension';
  if (CAMERA.test(text)) return 'camera';
  const oneWord = !/\s/.test(text);
  if (oneWord && HASH.test(text) && /\d/.test(text)) return 'hash';
  if (oneWord && DIMENSIONS.test(text)) return 'dimensions';
  if (oneWord && text.includes('_') && /[a-z0-9]_[a-z0-9]/i.test(text)) return 'underscore';
  if (fileName !== undefined && fileName !== null && oneWord) {
    const fromFile = stem(fileStem(fileName));
    if (fromFile !== '' && stem(text) === fromFile) return 'matches-file-name';
  }
  return null;
}
