import { isRuleId, type RuleId } from './rules.ts';
import { MIN_REASON_LENGTH, type Violation } from './scan.ts';

/**
 * An exception for a file format that has no comments, such as a JSON message catalog.
 * It suppresses violations of `rule` in `file` on any line containing `text`.
 */
export interface AllowlistEntry {
  readonly file: string;
  readonly rule: RuleId;
  readonly text: string;
  readonly reason: string;
}

export interface AllowlistResult {
  readonly violations: Violation[];
  readonly unused: AllowlistEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(entry: Record<string, unknown>, key: string, index: number): string {
  const value = entry[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`allowlist entry ${String(index)}: "${key}" must be a non-empty string`);
  }
  return value;
}

/** Validates the parsed JSON of `claims-lint.allow.json`. Throws on any malformed entry. */
export function parseAllowlist(input: unknown): AllowlistEntry[] {
  if (!isRecord(input) || !Array.isArray(input['entries'])) {
    throw new Error('allowlist must be an object with an "entries" array');
  }
  return input['entries'].map((raw: unknown, index): AllowlistEntry => {
    if (!isRecord(raw)) {
      throw new Error(`allowlist entry ${String(index)} must be an object`);
    }
    const file = requireString(raw, 'file', index);
    const rule = requireString(raw, 'rule', index);
    const text = requireString(raw, 'text', index);
    const reason = requireString(raw, 'reason', index);
    if (!isRuleId(rule)) {
      throw new Error(`allowlist entry ${String(index)}: unknown rule "${rule}"`);
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      throw new Error(
        `allowlist entry ${String(index)}: "reason" needs at least ${String(MIN_REASON_LENGTH)} characters`,
      );
    }
    return { file, rule, text, reason };
  });
}

/** Removes allowlisted violations and reports entries that matched nothing. */
export function applyAllowlist(
  violations: readonly Violation[],
  entries: readonly AllowlistEntry[],
): AllowlistResult {
  const used = new Set<AllowlistEntry>();
  const kept = violations.filter((v) => {
    const entry = entries.find(
      (e) => e.file === v.file && e.rule === v.rule && v.lineText.includes(e.text),
    );
    if (entry === undefined) {
      return true;
    }
    used.add(entry);
    return false;
  });
  return { violations: kept, unused: entries.filter((e) => !used.has(e)) };
}
