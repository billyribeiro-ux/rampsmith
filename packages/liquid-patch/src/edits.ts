/**
 * The span edit model (PLAN §12, ADR-007, ADR-101).
 *
 * Offsets are JavaScript string indexes, that is UTF-16 code units, into the file's contents as
 * decoded from UTF-8: the unit `@shopify/liquid-html-parser` uses for `position.start` and
 * `position.end`. A span is half-open, `[start, end)`; `start === end` is an insertion.
 */
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { countUnparsedLiquid, parseLiquid } from './parse.ts';

export interface Edit {
  /** Theme-relative path of the file, such as `layout/theme.liquid`. */
  readonly file: string;
  /** First code unit replaced, inclusive. */
  readonly start: number;
  /** End of the replaced span, exclusive; equal to `start` for an insertion. */
  readonly end: number;
  /** Text written in place of the span. */
  readonly replacement: string;
}

export type EditErrorCode =
  | 'invalid-offset'
  | 'out-of-bounds'
  | 'splits-surrogate-pair'
  | 'invalid-replacement'
  | 'file-mismatch'
  | 'overlap'
  | 'unsupported-file'
  | 'source-unparseable'
  | 'result-unparseable'
  | 'unparsed-liquid-added';

export interface EditError {
  readonly code: EditErrorCode;
  readonly message: string;
}

export type ApplyResult =
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly error: EditError };

/** How a file is validated after editing, from its extension; `null` when it cannot be. */
export function fileKind(path: string): 'liquid' | 'json' | null {
  if (path.endsWith('.liquid')) return 'liquid';
  if (path.endsWith('.json')) return 'json';
  return null;
}

function fail(code: EditErrorCode, message: string): ApplyResult {
  return { ok: false, error: { code, message } };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when `offset` falls between the two code units of one astral character. */
function splitsSurrogatePair(source: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < source.length &&
    isHighSurrogate(source.charCodeAt(offset - 1)) &&
    isLowSurrogate(source.charCodeAt(offset))
  );
}

function describe(edit: Edit): string {
  return `[${String(edit.start)}, ${String(edit.end)})`;
}

/**
 * Checks one file's edits against its source. The overlap rule: after sorting by start, an
 * edit may begin where the previous one ends but not before; and two insertions at the same
 * offset are rejected, because their order would be a guess. An insertion at the start or the
 * end of a replaced span is allowed: it lands before or after the replacement.
 */
function validate(source: string, edits: readonly Edit[]): EditError | null {
  const file = edits[0]?.file;
  for (const edit of edits) {
    if (edit.file !== file) {
      return {
        code: 'file-mismatch',
        message: `edits for ${String(file)} and ${edit.file} were given together`,
      };
    }
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      return { code: 'invalid-offset', message: `offsets must be integers: ${describe(edit)}` };
    }
    if (edit.start < 0 || edit.end < edit.start) {
      return {
        code: 'invalid-offset',
        message: `start must be 0 <= start <= end: ${describe(edit)}`,
      };
    }
    if (edit.end > source.length) {
      return {
        code: 'out-of-bounds',
        message: `${describe(edit)} ends past the file length ${String(source.length)}`,
      };
    }
    if (splitsSurrogatePair(source, edit.start) || splitsSurrogatePair(source, edit.end)) {
      return {
        code: 'splits-surrogate-pair',
        message: `${describe(edit)} cuts a character encoded as a surrogate pair`,
      };
    }
    if (!edit.replacement.isWellFormed()) {
      return {
        code: 'invalid-replacement',
        message: `the replacement for ${describe(edit)} contains a lone surrogate`,
      };
    }
  }
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let maxEnd = 0;
  let previous: Edit | undefined;
  for (const edit of sorted) {
    if (previous !== undefined) {
      if (edit.start < maxEnd) {
        return {
          code: 'overlap',
          message: `${describe(edit)} overlaps an edit that ends at ${String(maxEnd)}`,
        };
      }
      if (
        edit.start === edit.end &&
        previous.start === previous.end &&
        previous.start === edit.start
      ) {
        return {
          code: 'overlap',
          message: `two insertions at offset ${String(edit.start)}; combine them into one edit`,
        };
      }
    }
    maxEnd = Math.max(maxEnd, edit.end);
    previous = edit;
  }
  return null;
}

/**
 * Validates and applies one file's edits from the end of the file backwards. No parsing: use
 * {@link applyEdits} for theme files. Every code unit outside the edited spans is kept.
 */
export function spliceEdits(source: string, edits: readonly Edit[]): ApplyResult {
  const error = validate(source, edits);
  if (error !== null) return { ok: false, error };
  // Descending start; for an insertion and a replacement at the same start, the replacement is
  // applied first so the insertion lands before it.
  const descending = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let contents = source;
  for (const edit of descending) {
    contents = contents.slice(0, edit.start) + edit.replacement + contents.slice(edit.end);
  }
  return { ok: true, contents };
}

const JSONC_OPTIONS = {
  allowTrailingComma: false,
  disallowComments: false,
  allowEmptyContent: false,
};

function jsonErrors(text: string): ParseError[] {
  const errors: ParseError[] = [];
  parseJsonc(text, errors, JSONC_OPTIONS);
  return errors;
}

/**
 * Applies one file's edits (all with the same `file`) and checks the result: a `.liquid` file
 * must still parse and must not gain Liquid the parser reads only as a string; a `.json` file
 * must still parse as JSON (comments allowed, as in Shopify theme JSON). The file is never
 * reprinted, so every code unit outside the edited spans stays identical.
 */
export function applyEdits(source: string, edits: readonly Edit[]): ApplyResult {
  const first = edits[0];
  if (first === undefined) return { ok: true, contents: source };
  const kind = fileKind(first.file);
  if (kind === null) {
    return fail('unsupported-file', `${first.file}: only .liquid and .json files are validated`);
  }
  const spliced = spliceEdits(source, edits);
  if (!spliced.ok) return spliced;
  if (kind === 'json') {
    if (jsonErrors(source).length > 0) {
      return fail('source-unparseable', `${first.file} is not valid JSON before editing`);
    }
    const errors = jsonErrors(spliced.contents);
    const firstError = errors[0];
    if (firstError !== undefined) {
      return fail(
        'result-unparseable',
        `${first.file} would not be valid JSON: error ${String(firstError.error)} at offset ${String(firstError.offset)}`,
      );
    }
    return spliced;
  }
  const before = parseLiquid(source);
  if (!before.ok) {
    return fail('source-unparseable', `${first.file} does not parse: ${before.error.message}`);
  }
  const after = parseLiquid(spliced.contents);
  if (!after.ok) {
    return fail('result-unparseable', `${first.file} would not parse: ${after.error.message}`);
  }
  if (countUnparsedLiquid(after.ast) > countUnparsedLiquid(before.ast)) {
    return fail(
      'unparsed-liquid-added',
      `${first.file}: the edits add Liquid markup the parser cannot read strictly`,
    );
  }
  return spliced;
}

/**
 * Where an offset of the original file lands after the edits: insertions at or before it and
 * edits that end at or before it shift it. `null` when an edit replaces the code unit at that
 * offset. Lets a caller find an element again after patching, or chain recipes.
 */
export function mapOffset(offset: number, edits: readonly Edit[]): number | null {
  let delta = 0;
  for (const edit of edits) {
    if (edit.start <= offset && offset < edit.end) return null;
    if (edit.end <= offset) delta += edit.replacement.length - (edit.end - edit.start);
  }
  return offset + delta;
}
