// CSV for spreadsheets, safe against formula injection (ADR-224). Every field is quoted with
// embedded quotes doubled (RFC 4180). A field whose first non-blank character could start a
// spreadsheet formula gets a leading apostrophe, as OWASP's CSV injection guidance advises,
// so a product title such as `=HYPERLINK(...)` is shown as text and never evaluated.
import { sanitizeText } from './escape.ts';

/**
 * Characters that make Excel, LibreOffice or Google Sheets read a cell as a formula: the
 * OWASP list (`=`, `+`, `-`, `@`, tab, carriage return), line feed, and the full-width forms
 * of the four symbols, which some spreadsheet locales also accept.
 */
const FORMULA_START = /^\s*[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/u;

export function csvCell(value: string): string {
  const clean = sanitizeText(value);
  const safe = FORMULA_START.test(clean) ? `'${clean}` : clean;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * A whole CSV file: a UTF-8 byte-order mark (so Excel reads the encoding correctly), the
 * header row, then each row, every line ending in CRLF.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((row, index) => {
    if (row.length !== header.length) {
      throw new Error(
        `row ${String(index)} has ${String(row.length)} field(s); the header has ${String(header.length)}`,
      );
    }
    return row.map(csvCell).join(',');
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
