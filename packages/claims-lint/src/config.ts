export interface Config {
  /** Globs, relative to the repository root, of files that carry user-facing copy. */
  readonly include: readonly string[];
  /** Globs removed from the include set. */
  readonly exclude: readonly string[];
  /** Path of the allowlist for formats without comments, relative to the root. */
  readonly allowlist: string;
}

/** Build output and dependencies are never scanned, whatever the config says. */
export const ALWAYS_EXCLUDED: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svelte-kit/**',
  '**/build/**',
  '**/dist/**',
  '**/coverage/**',
  'target/**',
];

function stringArray(value: unknown, key: string, { nonEmpty }: { nonEmpty: boolean }): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((v): v is string => typeof v === 'string' && v.length > 0)
  ) {
    throw new Error(`config "${key}" must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) {
    throw new Error(`config "${key}" must list at least one glob`);
  }
  return value;
}

/** Validates the parsed JSON of `claims-lint.config.json`. */
export function parseConfig(input: unknown): Config {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config must be a JSON object');
  }
  const record = input as Record<string, unknown>;
  const include = stringArray(record['include'], 'include', { nonEmpty: true });
  const exclude = stringArray(record['exclude'] ?? [], 'exclude', { nonEmpty: false });
  const allowlist = record['allowlist'];
  if (typeof allowlist !== 'string' || allowlist.length === 0) {
    throw new Error('config "allowlist" must be a path');
  }
  return { include, exclude, allowlist };
}
