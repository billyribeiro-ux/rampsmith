import { RULES, isRuleId, type RuleId } from './rules.ts';

export interface Violation {
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, in UTF-16 code units. */
  readonly column: number;
  readonly rule: RuleId;
  readonly match: string;
  readonly lineText: string;
  readonly message: string;
}

type MarkerProblemKind = 'missing-reason' | 'unknown-rule' | 'unused';

export interface MarkerProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: MarkerProblemKind;
  readonly message: string;
}

export interface ScanResult {
  readonly violations: Violation[];
  readonly markerProblems: MarkerProblem[];
}

/** A reason shorter than this cannot explain why a banned phrase is acceptable. */
export const MIN_REASON_LENGTH = 10;

const MARKER = /claims-lint-allow\s+([\w,-]+)(?:\s*:\s*([^\n]*))?/u;
const COMMENT_CLOSERS = /\s*(?:-->|\*\/\s*\}?|#\}|%\}|\}\})\s*$/u;

interface Marker {
  readonly line: number;
  readonly column: number;
  readonly rules: readonly RuleId[];
  readonly used: Set<RuleId>;
}

/**
 * Scans one file's text for banned claims.
 *
 * An allow marker, `claims-lint-allow <rule>[,<rule>]: <reason>`, written in any comment
 * syntax, suppresses the named rules on its own line and on the line right after it. A
 * marker without a reason, naming an unknown rule, or suppressing nothing is reported, so
 * exceptions stay explained and never outlive the copy they were written for.
 */
export function scanText(file: string, text: string): ScanResult {
  const lines = text.split(/\r?\n/u);
  const markerProblems: MarkerProblem[] = [];
  const markers: Marker[] = [];
  /** Where each marker's own text sits, valid or not, so it is never scanned as copy. */
  const markerSpans = new Map<number, { start: number; end: number }>();

  lines.forEach((lineText, index) => {
    const found = MARKER.exec(lineText);
    if (found === null) {
      return;
    }
    const line = index + 1;
    const column = found.index + 1;
    markerSpans.set(line, { start: found.index, end: found.index + found[0].length });
    const ruleList = found[1] ?? '';
    const reason = (found[2] ?? '').replace(COMMENT_CLOSERS, '').trim();
    const named = ruleList.split(',').filter((r) => r.length > 0);
    const unknown = named.filter((r) => !isRuleId(r));
    if (unknown.length > 0) {
      markerProblems.push({
        file,
        line,
        column,
        kind: 'unknown-rule',
        message: `allow marker names unknown rule(s): ${unknown.join(', ')}`,
      });
      return;
    }
    if (reason.length < MIN_REASON_LENGTH) {
      markerProblems.push({
        file,
        line,
        column,
        kind: 'missing-reason',
        message: `allow marker needs a reason of at least ${String(MIN_REASON_LENGTH)} characters after a colon`,
      });
      return;
    }
    markers.push({
      line,
      column,
      rules: named.filter(isRuleId),
      used: new Set(),
    });
  });

  const violations: Violation[] = [];
  lines.forEach((lineText, index) => {
    const line = index + 1;
    const span = markerSpans.get(line);
    for (const rule of RULES) {
      for (const match of lineText.matchAll(rule.pattern)) {
        if (span !== undefined && match.index >= span.start && match.index < span.end) {
          continue;
        }
        const suppressor = markers.find(
          (m) => (m.line === line || m.line === line - 1) && m.rules.includes(rule.id),
        );
        if (suppressor !== undefined) {
          suppressor.used.add(rule.id);
          continue;
        }
        violations.push({
          file,
          line,
          column: match.index + 1,
          rule: rule.id,
          match: match[0],
          lineText,
          message: rule.message,
        });
      }
    }
  });

  for (const marker of markers) {
    const unused = marker.rules.filter((r) => !marker.used.has(r));
    if (unused.length > 0) {
      markerProblems.push({
        file,
        line: marker.line,
        column: marker.column,
        kind: 'unused',
        message: `allow marker suppresses nothing for: ${unused.join(', ')}; remove it`,
      });
    }
  }

  violations.sort((a, b) => a.line - b.line || a.column - b.column);
  return { violations, markerProblems };
}
