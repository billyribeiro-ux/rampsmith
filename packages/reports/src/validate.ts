// Input checks shared by every renderer. The inputs come from the database and from merchants,
// so each renderer validates before it renders and refuses, with the field named, anything a
// report could misstate: an empty name, an invalid date, a count that is not a whole number.
import { sanitizeText } from './escape.ts';

/** An input a report cannot be rendered from. `field` names the offending input path. */
export class ReportInputError extends Error {
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`${field}: ${problem}`);
    this.name = 'ReportInputError';
    this.field = field;
  }
}

/**
 * A short, single-line, quoted form of an offending value for an error message: at most 40
 * characters, with control characters and line breaks escaped, so an error never carries a
 * forged log line or a whole hostile input.
 */
export function quote(value: string): string {
  const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(short).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Longest free text accepted in one field, so a hostile input cannot stall the PDF printer. */
const MAX_TEXT = 2_000;
/** Longest single-line value, such as a name. */
export const MAX_LINE = 200;
/** Most items accepted in one list input. */
const MAX_ITEMS = 10_000;

/** Sanitized, trimmed text that is not empty and not longer than `max`. */
export function requireText(field: string, value: string, max = MAX_TEXT): string {
  const clean = sanitizeText(value).trim();
  if (clean === '') {
    throw new ReportInputError(field, 'must not be empty');
  }
  if (clean.length > max) {
    throw new ReportInputError(field, `must be at most ${String(max)} characters`);
  }
  return clean;
}

/** One line of text: as `requireText`, and with no line break. */
export function requireLine(field: string, value: string, max = MAX_LINE): string {
  const clean = requireText(field, value, max);
  if (clean.includes('\n')) {
    throw new ReportInputError(field, 'must be a single line');
  }
  return clean;
}

export function optionalText(
  field: string,
  value: string | undefined,
  max = MAX_TEXT,
): string | undefined {
  return value === undefined ? undefined : requireText(field, value, max);
}

export function requireDate(field: string, value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ReportInputError(field, 'must be a valid date');
  }
  return value;
}

export function requireCount(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReportInputError(field, 'must be a whole number of zero or more');
  }
  return value;
}

export function requireItems<T>(field: string, items: readonly T[], max = MAX_ITEMS): readonly T[] {
  if (items.length > max) {
    throw new ReportInputError(field, `must hold at most ${String(max)} items`);
  }
  return items;
}

export function requireOneOf<T extends string>(
  field: string,
  value: string,
  allowed: readonly T[],
): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) {
    throw new ReportInputError(field, `must be one of ${allowed.join(', ')}`);
  }
  return found;
}
